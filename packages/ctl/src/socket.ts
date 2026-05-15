import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readLogFile, type Supervisor } from './supervisor.js';
import type { StatusReporter } from './status-reporter.js';
import { probeClaudeSession } from './tmux.js';
import {
  CLAUDE_ACTIVITY_STATES,
  DEFAULT_CLAUDE_SESSION_NAME,
  type CtlRequest,
  type CtlResponse,
  type LogEvent,
} from './types.js';
import { loadConfig } from './config.js';

export interface ServerOptions {
  socketPath: string;
  supervisor: Supervisor;
  logDir: string;
  configPath: string;
  /** Optional — present when the daemon runs the status reporter. */
  reporter?: StatusReporter;
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
  await chmod(opts.socketPath, 0o660);
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
      const cfg = await loadConfig(opts.configPath);
      const diff = await opts.supervisor.reload(cfg);
      writeLine(sock, { ok: true, data: diff });
      sock.end();
      return;
    }
    case 'claude-session': {
      const data = await probeClaudeSession(req.sessionName ?? DEFAULT_CLAUDE_SESSION_NAME);
      writeLine(sock, { ok: true, data });
      sock.end();
      return;
    }
    case 'claude-state': {
      if (!CLAUDE_ACTIVITY_STATES.includes(req.state)) {
        writeLine(sock, { ok: false, error: `invalid claude state: ${String(req.state)}` });
      } else {
        opts.reporter?.setClaudeState(req.state);
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
