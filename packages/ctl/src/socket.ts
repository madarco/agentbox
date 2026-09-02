import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readLogFile, type Supervisor } from './supervisor.js';
import { collectPorts, type StatusReporter } from './status-reporter.js';
import { probeAgentSession } from './tmux.js';
import {
  AGENT_ACTIVITY_STATES,
  type CtlRequest,
  type CtlResponse,
  type LogEvent,
} from './types.js';
import { loadConfig, type CtlConfig } from './config.js';

export interface ServerOptions {
  socketPath: string;
  supervisor: Supervisor;
  logDir: string;
  configPath: string;
  /** Optional — present when the daemon runs the status reporter. */
  reporter?: StatusReporter;
  /**
   * How the `reload` op rebuilds the config. Defaults to reading `configPath`.
   *
   * The daemon overrides it so a reload re-folds the units a service agent
   * contributed over `agents.list`. Without the hook, `agentbox-ctl reload` read
   * the yaml alone and its diff DELETED the agent's service — the failure mode
   * being that editing an unrelated key stopped the box's daemon.
   */
  reloadConfig?: () => Promise<CtlConfig>;
}

export async function startServer(opts: ServerOptions): Promise<Server> {
  await mkdir(dirname(opts.socketPath), { recursive: true });
  await unlink(opts.socketPath).catch(() => {});

  const server = createServer((sock) => {
    handleConnection(sock, opts).catch((err: unknown) => {
      // Best-effort: report errors back if the socket is still open.
      const msg = err instanceof Error ? err.message : String(err);
      writeLine(sock, { ok: false, error: msg });
      sock.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  // Tightening to 0660 is defence-in-depth — only the owner + group should
  // connect. fuse-overlayfs (the box's writable-layer driver) returns EINVAL
  // when chmod targets a unix-socket inode; crashing the daemon over that is
  // worse than the slightly looser 0755 the bind(2) default gives us. The
  // container FS is host-isolated and /run/agentbox/ is already vscode-only.
  await chmod(opts.socketPath, 0o660).catch(() => {});
  return server;
}

async function handleConnection(sock: Socket, opts: ServerOptions): Promise<void> {
  const reader = createLineReader(sock);
  const first = await reader.next();
  if (first.done) return;

  let req: CtlRequest;
  try {
    req = JSON.parse(first.value) as CtlRequest;
  } catch {
    writeLine(sock, { ok: false, error: 'invalid JSON' });
    sock.end();
    return;
  }

  switch (req.op) {
    case 'ping': {
      writeLine(sock, { ok: true, data: 'pong' });
      sock.end();
      return;
    }
    case 'status': {
      const data = {
        services: opts.supervisor.list(),
        tasks: opts.supervisor.listTasks(),
        ports: await collectPorts(opts.supervisor),
      };
      writeLine(sock, { ok: true, data });
      sock.end();
      return;
    }
    case 'task-status': {
      writeLine(sock, { ok: true, data: opts.supervisor.listTasks() });
      sock.end();
      return;
    }
    case 'wait-ready': {
      const data = await opts.supervisor.waitReady({
        timeoutMs: req.timeoutMs,
        units: req.units,
      });
      writeLine(sock, { ok: true, data });
      sock.end();
      return;
    }
    case 'run-task': {
      try {
        const data = await opts.supervisor.runTask(req.name, req.force);
        writeLine(sock, { ok: true, data });
      } catch (err) {
        writeLine(sock, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      sock.end();
      return;
    }
    case 'logs': {
      await handleLogs(sock, opts, req);
      return;
    }
    case 'restart': {
      const r = opts.supervisor.get(req.service);
      if (!r) {
        writeLine(sock, { ok: false, error: `unknown service: ${req.service}` });
      } else {
        await r.restart();
        writeLine(sock, { ok: true, data: r.getStatus() });
      }
      sock.end();
      return;
    }
    case 'stop': {
      const r = opts.supervisor.get(req.service);
      if (!r) {
        writeLine(sock, { ok: false, error: `unknown service: ${req.service}` });
      } else {
        await r.stop();
        writeLine(sock, { ok: true, data: r.getStatus() });
      }
      sock.end();
      return;
    }
    case 'start': {
      const r = opts.supervisor.get(req.service);
      if (!r) {
        writeLine(sock, { ok: false, error: `unknown service: ${req.service}` });
      } else {
        r.start();
        writeLine(sock, { ok: true, data: r.getStatus() });
      }
      sock.end();
      return;
    }
    case 'reload': {
      const cfg = await (opts.reloadConfig ?? (() => loadConfig(opts.configPath)))();
      const diff = await opts.supervisor.reload(cfg);
      writeLine(sock, { ok: true, data: diff });
      sock.end();
      return;
    }
    case 'agent-session': {
      // Fail-closed, like `agent-state` below. This used to default to claude's
      // session name, which meant a caller that forgot the field silently got a
      // probe of a DIFFERENT agent's session and a confident answer about it.
      // Every real caller passes one (`agent-session.ts` defaults it to the
      // agent id), so nothing legitimate reaches this branch.
      if (typeof req.sessionName !== 'string' || req.sessionName.length === 0) {
        writeLine(sock, { ok: false, error: 'agent-session requires a sessionName' });
        sock.end();
        return;
      }
      const data = await probeAgentSession(req.sessionName);
      writeLine(sock, { ok: true, data });
      sock.end();
      return;
    }
    case 'agent-state': {
      // Fail-closed on both fields: with AgentId open, the agent name is no
      // longer checkable against a union, so an empty one must not silently
      // create a phantom entry in the status map.
      if (typeof req.agent !== 'string' || req.agent.length === 0) {
        writeLine(sock, { ok: false, error: `invalid agent: ${String(req.agent)}` });
      } else if (!AGENT_ACTIVITY_STATES.includes(req.state)) {
        writeLine(sock, { ok: false, error: `invalid ${req.agent} state: ${String(req.state)}` });
      } else {
        opts.reporter?.setAgentState(req.agent, req.state, {
          plan: req.plan,
          question: req.question,
          clearPending: req.clearPending,
        });
        writeLine(sock, { ok: true, data: 'ok' });
      }
      sock.end();
      return;
    }
    default: {
      writeLine(sock, { ok: false, error: `unknown op` });
      sock.end();
    }
  }
}

async function handleLogs(
  sock: Socket,
  opts: ServerOptions,
  req: { service: string; tail?: number; follow?: boolean },
): Promise<void> {
  const tailN = req.tail ?? 200;
  const follow = req.follow ?? false;
  const runner = opts.supervisor.get(req.service);

  let initial: LogEvent[];
  if (runner) {
    const fromRing = runner.tail(tailN);
    initial = fromRing.length > 0 ? fromRing : await readLogFile(opts.logDir, req.service, tailN);
  } else {
    // Service is gone from current config but historical logs may exist.
    initial = await readLogFile(opts.logDir, req.service, tailN);
  }
  writeLine(sock, { ok: true, data: { events: initial, follow } });

  if (!follow || !runner) {
    sock.end();
    return;
  }

  const onLog = (ev: LogEvent): void => {
    if (ev.service !== req.service) return;
    writeLine(sock, { ok: true, data: { event: ev } });
  };
  runner.on('log', onLog);
  sock.on('close', () => {
    runner.off('log', onLog);
  });
  sock.on('error', () => {
    runner.off('log', onLog);
  });
}

function writeLine(sock: Socket, msg: CtlResponse): void {
  if (sock.writable) sock.write(`${JSON.stringify(msg)}\n`);
}

async function* createLineReader(sock: Socket): AsyncGenerator<string> {
  let buf = '';
  sock.setEncoding('utf8');
  for await (const chunk of sock) {
    buf += chunk as string;
    let idx = buf.indexOf('\n');
    while (idx !== -1) {
      yield buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      idx = buf.indexOf('\n');
    }
  }
  if (buf.length > 0) yield buf;
}
