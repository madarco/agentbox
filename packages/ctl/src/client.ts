import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import type {
  ClaudeActivityState,
  ClaudePlanPayload,
  ClaudeQuestionPayload,
  ClaudeSessionStatus,
  CtlRequest,
  CtlResponse,
  LogEvent,
  ReloadResult,
  ServiceStatus,
  StatusReply,
  TaskStatus,
  WaitReadyArgs,
  WaitReadyReply,
} from './types.js';

export interface ConnectOptions {
  socketPath: string;
  /** Default 3000 ms. */
  timeoutMs?: number;
}

interface NodeErrno extends Error {
  code?: string;
}

/**
 * Best-effort daemon respawn when the unix socket is dead. `docker exec -d`
 * leaves no log when the daemon crashes on startup and Node doesn't unlink
 * unix sockets on exit, so an orphaned file is the symptom we see most often.
 * Spawning the bin detached and polling for a fresh listener recovers without
 * needing host involvement — mirrors `ensureRelay()` on the host side.
 *
 * Gated on `AGENTBOX=1` (set on every box at `docker run`) so unit tests on
 * the host — which start an ephemeral server with no `agentbox-ctl` bin
 * anywhere on PATH — don't accidentally spawn anything.
 */
async function tryReviveDaemon(socketPath: string): Promise<boolean> {
  if (process.env.AGENTBOX !== '1') return false;
  try {
    const child = spawn('agentbox-ctl', ['daemon'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    return false;
  }
  // The daemon `unlink`s any stale socket file before `listen()`, so once the
  // file reappears it's bound to a live listener.
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (existsSync(socketPath)) return true;
  }
  return false;
}

async function connectOnce(opts: ConnectOptions): Promise<Socket> {
  const sock = createConnection(opts.socketPath);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`connect ${opts.socketPath} timed out`));
    }, opts.timeoutMs ?? 3000);
    sock.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return sock;
}

async function connect(opts: ConnectOptions): Promise<Socket> {
  try {
    return await connectOnce(opts);
  } catch (err) {
    // Only ECONNREFUSED (stale socket file, no listener) and ENOENT (no file
    // at all) suggest a missing daemon. Anything else (EACCES, ETIMEDOUT, …)
    // is a real failure we shouldn't try to paper over.
    const code = (err as NodeErrno).code;
    if (code !== 'ECONNREFUSED' && code !== 'ENOENT') throw err;
    const revived = await tryReviveDaemon(opts.socketPath);
    if (!revived) throw err;
    return await connectOnce(opts);
  }
}

async function sendOneShot<T>(opts: ConnectOptions, req: CtlRequest): Promise<T> {
  const sock = await connect(opts);
  sock.write(`${JSON.stringify(req)}\n`);
  let buf = '';
  sock.setEncoding('utf8');
  for await (const chunk of sock) {
    buf += chunk as string;
    const idx = buf.indexOf('\n');
    if (idx !== -1) {
      const line = buf.slice(0, idx);
      sock.end();
      return parseResponse<T>(line);
    }
  }
  // Connection closed before we got a full line.
  if (buf.length > 0) return parseResponse<T>(buf);
  throw new Error('connection closed with no response');
}

function parseResponse<T>(line: string): T {
  const parsed = JSON.parse(line) as CtlResponse;
  if (parsed.ok) return parsed.data as T;
  throw new Error(parsed.error);
}

export async function ping(opts: ConnectOptions): Promise<'pong'> {
  return sendOneShot<'pong'>(opts, { op: 'ping' });
}

export async function status(opts: ConnectOptions): Promise<StatusReply> {
  return sendOneShot<StatusReply>(opts, { op: 'status' });
}

export async function taskStatus(opts: ConnectOptions): Promise<TaskStatus[]> {
  return sendOneShot<TaskStatus[]>(opts, { op: 'task-status' });
}

export async function waitReady(
  opts: ConnectOptions,
  args: WaitReadyArgs = {},
): Promise<WaitReadyReply> {
  return sendOneShot<WaitReadyReply>(opts, {
    op: 'wait-ready',
    timeoutMs: args.timeoutMs,
    units: args.units,
  });
}

export async function runTask(
  opts: ConnectOptions,
  name: string,
  force?: boolean,
): Promise<TaskStatus> {
  return sendOneShot<TaskStatus>(opts, { op: 'run-task', name, force });
}

export async function restart(opts: ConnectOptions, service: string): Promise<ServiceStatus> {
  return sendOneShot<ServiceStatus>(opts, { op: 'restart', service });
}

export async function stop(opts: ConnectOptions, service: string): Promise<ServiceStatus> {
  return sendOneShot<ServiceStatus>(opts, { op: 'stop', service });
}

export async function start(opts: ConnectOptions, service: string): Promise<ServiceStatus> {
  return sendOneShot<ServiceStatus>(opts, { op: 'start', service });
}

export async function reload(opts: ConnectOptions): Promise<ReloadResult> {
  return sendOneShot<ReloadResult>(opts, { op: 'reload' });
}

export async function claudeSession(
  opts: ConnectOptions & { sessionName?: string },
): Promise<ClaudeSessionStatus> {
  return sendOneShot<ClaudeSessionStatus>(opts, {
    op: 'claude-session',
    sessionName: opts.sessionName,
  });
}

export async function claudeState(
  opts: ConnectOptions,
  state: ClaudeActivityState,
  payload?: {
    plan?: ClaudePlanPayload;
    question?: ClaudeQuestionPayload;
    clearPending?: boolean;
  },
): Promise<'ok'> {
  return sendOneShot<'ok'>(opts, {
    op: 'claude-state',
    state,
    ...(payload?.plan ? { plan: payload.plan } : {}),
    ...(payload?.question ? { question: payload.question } : {}),
    ...(payload?.clearPending ? { clearPending: true } : {}),
  });
}

export async function codexState(
  opts: ConnectOptions,
  state: ClaudeActivityState,
): Promise<'ok'> {
  return sendOneShot<'ok'>(opts, { op: 'codex-state', state });
}

export async function opencodeState(
  opts: ConnectOptions,
  state: ClaudeActivityState,
): Promise<'ok'> {
  return sendOneShot<'ok'>(opts, { op: 'opencode-state', state });
}

export interface LogsResult {
  initial: LogEvent[];
  /**
   * When `follow: true` was passed, this async iterator yields further events
   * until the caller breaks out (which closes the socket).
   */
  follow?: AsyncIterableIterator<LogEvent>;
}

export async function logs(
  opts: ConnectOptions,
  args: { service: string; tail?: number; follow?: boolean },
): Promise<LogsResult> {
  const sock = await connect(opts);
  sock.write(`${JSON.stringify({ op: 'logs', ...args })}\n`);

  const lines = createLineIterator(sock);
  const first = await lines.next();
  if (first.done) {
    sock.end();
    throw new Error('connection closed with no response');
  }
  const parsed = JSON.parse(first.value) as CtlResponse;
  if (!parsed.ok) {
    sock.end();
    throw new Error(parsed.error);
  }
  const data = parsed.data as { events: LogEvent[]; follow: boolean };
  if (!data.follow) {
    sock.end();
    return { initial: data.events };
  }

  const followGen = (async function* () {
    try {
      for await (const line of lines) {
        const p = JSON.parse(line) as CtlResponse;
        if (p.ok && p.data && typeof p.data === 'object' && 'event' in p.data) {
          yield (p.data as { event: LogEvent }).event;
        }
      }
    } finally {
      sock.end();
    }
  })();

  return { initial: data.events, follow: followGen };
}

async function* createLineIterator(sock: Socket): AsyncIterableIterator<string> {
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
