import { timingSafeEqual } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PTY_PROTOCOL_VERSION,
  PtyFrameDecoder,
  PtyFrameError,
  encodeCtrl,
  encodeData,
  encodeExit,
  type PtyCtrlFromClient,
  type PtyCtrlFromHost,
  type PtyWindowSize,
} from '@agentbox/core';
import {
  ensurePtyDir,
  ptySocketPath,
  removePtySession,
  writePtyMeta,
  type PtySessionMeta,
} from '@agentbox/sandbox-core';
import { loadPtyBackend, type IPtyLike } from './pty-backend.js';
import { PTY_REPLAY_RESET, PtyRing } from './pty-ring.js';

export interface PtyHostSpec {
  managerId: string;
  workspaceId: string;
  agent: string;
  cwd: string;
  /** Login shell; the manager script is handed to it with `-lc`. */
  shell: string;
  script: string;
  env: Record<string, string>;
  token: string;
  runId: string;
  cols: number;
  rows: number;
  pinned: boolean;
  leaseGraceMs: number;
  scrollbackBytes: number;
  windowSize: PtyWindowSize;
  submitDelayMs: number;
  /** Defaults to ~/.agentbox; tests point it at a temp dir. */
  baseDir?: string;
}

export interface PtyHostHandle {
  socketPath: string;
  /** Resolves when the agent has exited and the host has cleaned up. */
  done: Promise<number>;
  stop(reason?: string): Promise<void>;
}

export class PtyHostAlreadyRunning extends Error {
  constructor(readonly socketPath: string) {
    super(`a pty host is already listening on ${socketPath}`);
    this.name = 'PtyHostAlreadyRunning';
  }
}

export class PtyBackendUnavailable extends Error {
  constructor() {
    super('node-pty is not available (optional prebuild missing)');
    this.name = 'PtyBackendUnavailable';
  }
}

const REAP_TICK_MS = 5_000;
const NUDGE_DELAY_MS = 50;
const STOP_LADDER_MS = 2_000;
const HELLO_TIMEOUT_MS = 5_000;
/** macOS `sun_path` is 104 bytes including the NUL; Linux gives 108. */
const MAX_SOCKET_PATH = 100;

interface Client {
  socket: Socket;
  decoder: PtyFrameDecoder;
  joiner: Utf8Joiner;
  id?: string;
  kind?: string;
  cols: number;
  rows: number;
  /** Last input or resize — reported as idleness, never used for sizing. */
  lastActiveAt: number;
  /**
   * Last attach or explicit resize. Sizing keys off this, not off keystrokes:
   * a client typing in a small window must not silently shrink a larger one the
   * next time some unrelated client attaches or leaves.
   */
  sizedAt: number;
  authed: boolean;
}

interface Lease {
  lastSeenAt: number;
}

/**
 * Splits of a multi-byte character across two reads are rare but real (a chunk
 * boundary falls wherever the kernel put it), and node-pty's `write` takes a
 * string — so an incomplete tail must be held back rather than decoded into a
 * replacement character the agent would receive as garbage.
 */
export class Utf8Joiner {
  private tail = new Uint8Array(0);
  private readonly decoder = new TextDecoder('utf-8');

  push(chunk: Uint8Array): string {
    const merged = new Uint8Array(this.tail.length + chunk.length);
    merged.set(this.tail, 0);
    merged.set(chunk, this.tail.length);
    const cut = completeLength(merged);
    this.tail = merged.slice(cut);
    return cut === 0 ? '' : this.decoder.decode(merged.slice(0, cut));
  }
}

/** Length of the prefix of `bytes` that ends on a complete UTF-8 sequence. */
function completeLength(bytes: Uint8Array): number {
  for (let back = 1; back <= 3 && back <= bytes.length; back += 1) {
    const byte = bytes[bytes.length - back] as number;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte, keep walking back
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Is something already serving this socket path? A stale socket file from a
 * crashed host must be replaced, but a live one must never be — unlinking it
 * would strand every attached client while the agent kept running unreachable.
 */
export async function probeSocket(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const sock = connect(path);
    const done = (alive: boolean): void => {
      sock.destroy();
      resolve(alive);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 500).unref();
  });
}

export async function startPtyHost(spec: PtyHostSpec): Promise<PtyHostHandle> {
  const backend = await loadPtyBackend();
  if (!backend) throw new PtyBackendUnavailable();

  const socketPath = ptySocketPath(spec.managerId, spec.baseDir);
  // A unix socket path longer than the platform's `sun_path` fails `listen`
  // with a bare EINVAL, which reads as a kernel problem rather than a path
  // problem. Say what it actually is.
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    throw new Error(
      `socket path is ${Buffer.byteLength(socketPath)} bytes, over the ${MAX_SOCKET_PATH}-byte unix socket limit: ${socketPath}`,
    );
  }
  await ensurePtyDir(spec.baseDir);
  if (await probeSocket(socketPath)) throw new PtyHostAlreadyRunning(socketPath);
  await rm(socketPath, { force: true });

  const clients = new Set<Client>();
  const leases = new Map<string, Lease>();
  const ring = new PtyRing({ maxBytes: spec.scrollbackBytes });
  let everLeased = false;
  let pinned = spec.pinned;
  let leaseGraceMs = spec.leaseGraceMs;
  let windowSize = spec.windowSize;
  let cols = spec.cols;
  let rows = spec.rows;
  let nudging = false;
  let stopping = false;

  const pty: IPtyLike = backend.ptySpawn(spec.shell, ['-lc', spec.script], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: spec.cwd,
    // One stable terminfo for every client (tray, CLI, a future web bridge), so
    // the agent's key and mouse encodings do not change with who is attached.
    env: { ...spec.env, TERM: 'xterm-256color' },
  });

  const meta: PtySessionMeta = {
    v: 1,
    managerId: spec.managerId,
    workspaceId: spec.workspaceId,
    agent: spec.agent,
    cwd: spec.cwd,
    socket: socketPath,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: spec.token,
    runId: spec.runId,
    cols,
    rows,
    pinned,
    leaseGraceMs,
  };
  await writePtyMeta(meta, spec.baseDir);

  const send = (client: Client, bytes: Uint8Array): void => {
    if (!client.socket.destroyed) client.socket.write(bytes);
  };
  const tell = (client: Client, message: PtyCtrlFromHost): void =>
    send(client, encodeCtrl(message));

  pty.onData((data) => {
    const bytes = Buffer.from(data, 'utf8');
    ring.push(bytes);
    const frame = encodeData(bytes);
    for (const client of clients) if (client.authed) send(client, frame);
  });

  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  pty.onExit(async ({ exitCode }) => {
    meta.exitCode = exitCode;
    meta.exitedAt = new Date().toISOString();
    const frame = encodeExit(exitCode);
    for (const client of clients) {
      if (client.authed) send(client, frame);
      client.socket.end();
    }
    server.close();
    clearInterval(reaper);
    await removePtySession(spec.managerId, spec.baseDir).catch(() => {});
    resolveDone(exitCode);
  });

  const applySize = (): void => {
    const connected = [...clients].filter((c) => c.authed);
    if (connected.length === 0) return;
    let next = connected[0] as Client;
    for (const client of connected) {
      if (windowSize === 'latest' && client.sizedAt > next.sizedAt) next = client;
      if (windowSize === 'smallest' && client.rows * client.cols < next.rows * next.cols)
        next = client;
      if (windowSize === 'largest' && client.rows * client.cols > next.rows * next.cols)
        next = client;
    }
    if (next.cols === cols && next.rows === rows) return;
    cols = next.cols;
    rows = next.rows;
    pty.resize(cols, rows);
    const size: PtyCtrlFromHost = { t: 'size', cols, rows, by: next.id ?? 'unknown' };
    for (const client of clients) if (client.authed) tell(client, size);
  };

  /**
   * A replayed frame is a snapshot, not a live one: the agent has no idea a new
   * client appeared. Toggling the size makes it redraw — the same SIGWINCH
   * repaint tmux got for free by owning a screen model.
   */
  const nudgeRepaint = (): void => {
    if (nudging) return;
    nudging = true;
    pty.resize(cols, Math.max(1, rows - 1));
    setTimeout(() => {
      pty.resize(cols, rows);
      nudging = false;
    }, NUDGE_DELAY_MS).unref();
  };

  const exitedWithin = async (ms: number): Promise<boolean> =>
    await Promise.race([done.then(() => true), delay(ms).then(() => false)]);

  const stopLadder = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    pty.kill('SIGHUP');
    if (await exitedWithin(STOP_LADDER_MS)) return;
    pty.kill('SIGTERM');
    if (await exitedWithin(STOP_LADDER_MS)) return;
    pty.kill('SIGKILL');
  };

  const onCtrl = async (client: Client, message: PtyCtrlFromClient): Promise<void> => {
    if (message.t === 'hello') {
      if (client.authed) return;
      if (message.v !== PTY_PROTOCOL_VERSION) {
        tell(client, {
          t: 'error',
          code: 'unsupported-version',
          message: `host speaks protocol ${PTY_PROTOCOL_VERSION}`,
        });
        client.socket.end();
        return;
      }
      if (!tokenMatches(spec.token, message.token)) {
        tell(client, { t: 'error', code: 'unauthorized', message: 'bad token' });
        client.socket.end();
        return;
      }
      client.authed = true;
      client.id = message.client.id;
      client.kind = message.client.kind;
      client.cols = message.client.cols;
      client.rows = message.client.rows;
      client.lastActiveAt = Date.now();
      client.sizedAt = Date.now();
      if (message.lease?.hold) {
        everLeased = true;
        leases.set(message.client.id, { lastSeenAt: Date.now() });
      }
      tell(client, {
        t: 'welcome',
        v: PTY_PROTOCOL_VERSION,
        managerId: spec.managerId,
        agent: spec.agent,
        cwd: spec.cwd,
        cols,
        rows,
        clients: [...clients].filter((c) => c.authed).length,
        ...(meta.exitCode === undefined ? {} : { exited: meta.exitCode }),
      });
      if (message.replay !== false) {
        const { prologue, body } = ring.replay();
        tell(client, { t: 'replay-begin', bytes: body.length });
        send(client, encodeData(Buffer.from(PTY_REPLAY_RESET + prologue, 'utf8')));
        if (body.length > 0) send(client, encodeData(body));
        tell(client, { t: 'replay-end' });
      }
      applySize();
      if (client.cols === cols && client.rows === rows) nudgeRepaint();
      return;
    }
    if (!client.authed) {
      tell(client, { t: 'error', code: 'unauthorized', message: 'hello first' });
      client.socket.end();
      return;
    }
    switch (message.t) {
      case 'resize':
        client.cols = message.cols;
        client.rows = message.rows;
        client.lastActiveAt = Date.now();
        client.sizedAt = Date.now();
        applySize();
        return;
      case 'inject': {
        // Newlines are flattened: each one would submit a fragment of the
        // message. The pause before Enter is the same rule the tmux carrier
        // needed — an agent TUI reads a burst ending in Enter as a paste and
        // keeps the Enter as a newline instead of submitting.
        const flat = message.text.replace(/\s*[\r\n]+\s*/gu, ' ').trim();
        if (flat.length > 0) pty.write(flat);
        if (message.submit !== false) {
          await delay(message.submitDelayMs ?? spec.submitDelayMs);
          pty.write('\r');
        }
        return;
      }
      case 'lease':
        everLeased = true;
        leases.set(client.id ?? 'anonymous', { lastSeenAt: Date.now() });
        tell(client, {
          t: 'lease-ack',
          expiresAt: new Date(Date.now() + message.ttlMs + leaseGraceMs).toISOString(),
        });
        return;
      case 'release':
        leases.delete(client.id ?? 'anonymous');
        if (leases.size === 0 && everLeased && !pinned) void stopLadder();
        return;
      case 'stop':
        void stopLadder();
        return;
      case 'signal':
        // INT goes in as a keystroke: the agent is the foreground job of a
        // shell inside the pty, so a signal to the pty's leader would miss it.
        if (message.name === 'INT') pty.write('\u0003');
        else pty.kill(`SIG${message.name}`);
        return;
      case 'status':
        tell(client, {
          t: 'status-report',
          managerId: spec.managerId,
          pid: process.pid,
          clients: [...clients].filter((c) => c.authed).length,
          leaseHolders: [...leases.keys()],
          pinned,
          idleMs: Date.now() - Math.max(...[...clients].map((c) => c.lastActiveAt), 0),
          cols,
          rows,
        });
        return;
      case 'configure':
        if (message.pinned !== undefined) pinned = message.pinned;
        if (message.leaseGraceMs !== undefined) leaseGraceMs = message.leaseGraceMs;
        if (message.windowSize !== undefined) windowSize = message.windowSize;
        meta.pinned = pinned;
        meta.leaseGraceMs = leaseGraceMs;
        await writePtyMeta(meta, spec.baseDir).catch(() => {});
        return;
      case 'bye':
        client.socket.end();
        return;
      default:
        return;
    }
  };

  const server: Server = createServer((socket) => {
    socket.setNoDelay(true);
    const client: Client = {
      socket,
      decoder: new PtyFrameDecoder(),
      joiner: new Utf8Joiner(),
      cols: spec.cols,
      rows: spec.rows,
      lastActiveAt: Date.now(),
      sizedAt: Date.now(),
      authed: false,
    };
    clients.add(client);
    const helloTimer = setTimeout(() => {
      if (!client.authed) socket.destroy();
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref();

    socket.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = client.decoder.push(chunk);
      } catch (err) {
        const code = err instanceof PtyFrameError ? err.code : 'bad-frame';
        tell(client, { t: 'error', code, message: (err as Error).message });
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.type === 'input') {
          if (!client.authed) continue;
          client.lastActiveAt = Date.now();
          const text = client.joiner.push(frame.payload);
          if (text.length > 0) pty.write(text);
          continue;
        }
        if (frame.type === 'ctrl') {
          void onCtrl(client, frame.message as PtyCtrlFromClient);
        }
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearTimeout(helloTimer);
      clients.delete(client);
      applySize();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  await chmod(socketPath, 0o600).catch(() => {});

  const reaper = setInterval(() => {
    const now = Date.now();
    // A connected holder is live by definition; only a gone one ages out.
    for (const client of clients) {
      if (client.authed && client.id && leases.has(client.id)) {
        leases.set(client.id, { lastSeenAt: now });
      }
    }
    if (!everLeased || pinned || stopping) return;
    for (const lease of leases.values()) {
      if (now - lease.lastSeenAt <= leaseGraceMs) return;
    }
    void stopLadder();
  }, REAP_TICK_MS);

  return {
    socketPath,
    done,
    stop: async () => {
      await stopLadder();
    },
  };
}
