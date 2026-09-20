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
  /**
   * `persistent` never reaps: only an explicit stop ends the session. `leased`
   * (the default) reaps once every lease holder has stayed away past the grace
   * window — a session nothing ever leased is never reaped either way.
   */
  lifetime?: 'leased' | 'persistent';
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
  let alive = true;
  let nudgeTimer: NodeJS.Timeout | undefined;

  /**
   * Every pty call is guarded: the agent can exit between a client's request
   * and the call it triggers (a deferred repaint nudge is the reliable way to
   * hit this), and node-pty throws ENOTTY out of the event loop for a write or
   * resize on a dead pty — an uncaught exception that would take the host with
   * it, killing the session's cleanup along the way.
   */
  const ptyWrite = (data: string): void => {
    if (!alive) return;
    try {
      pty.write(data);
    } catch {
      /* the agent is gone; the exit path handles the rest */
    }
  };
  const ptyResize = (nextCols: number, nextRows: number): void => {
    if (!alive) return;
    try {
      pty.resize(nextCols, nextRows);
    } catch {
      /* same */
    }
  };
  const ptyKill = (signal: string): void => {
    if (!alive) return;
    try {
      pty.kill(signal);
    } catch {
      /* same */
    }
  };

  const pty: IPtyLike = backend.ptySpawn(spec.shell, ['-lc', spec.script], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: spec.cwd,
    // One stable terminfo for every client (tray, CLI, a future web bridge), so
    // the agent's key and mouse encodings do not change with who is attached.
    env: { ...spec.env, TERM: 'xterm-256color' },
  });

  // From here on the agent is RUNNING. Anything that throws before the socket
  // is serving would otherwise leave it alive with no meta and no socket — a
  // process nothing can reach, find or reap.
  const killOrphan = (): void => {
    try {
      pty.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  };

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
  try {
    await writePtyMeta(meta, spec.baseDir);
  } catch (err) {
    killOrphan();
    throw err;
  }

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
    alive = false;
    if (nudgeTimer) clearTimeout(nudgeTimer);
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

  /**
   * Clients that are a terminal someone could be watching. The hub's own
   * control connection is not one (it attaches 0x0, reads nothing and leaves).
   */
  const watchers = (except?: Client): number =>
    [...clients].filter((c) => c !== except && c.authed && c.cols > 0 && c.rows > 0).length;

  const applySize = (): void => {
    // Only clients that ARE a terminal size the session. The hub connects with
    // 0x0 precisely so it never steers the size, and a pty resized to 0 is not
    // a small pty — node-pty throws, which used to take the host (and the
    // agent) down with it.
    const connected = [...clients].filter((c) => c.authed && c.cols > 0 && c.rows > 0);
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
    ptyResize(cols, rows);
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
    ptyResize(cols, Math.max(1, rows - 1));
    nudgeTimer = setTimeout(() => {
      ptyResize(cols, rows);
      nudging = false;
    }, NUDGE_DELAY_MS);
    nudgeTimer.unref();
  };

  const exitedWithin = async (ms: number): Promise<boolean> =>
    await Promise.race([done.then(() => true), delay(ms).then(() => false)]);

  const stopLadder = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    ptyKill('SIGHUP');
    if (await exitedWithin(STOP_LADDER_MS)) return;
    ptyKill('SIGTERM');
    if (await exitedWithin(STOP_LADDER_MS)) return;
    ptyKill('SIGKILL');
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
        if (flat.length > 0) ptyWrite(flat);
        if (message.submit !== false) {
          await delay(message.submitDelayMs ?? spec.submitDelayMs);
          ptyWrite('\r');
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
        // An explicit release is "I am done with this session", not "I went
        // away": no grace window, unless the session is meant to outlive it.
        leases.delete(client.id ?? 'anonymous');
        if (leases.size === 0 && everLeased && !pinned && spec.lifetime !== 'persistent') {
          void stopLadder();
        }
        return;
      case 'stop':
        void stopLadder();
        return;
      case 'signal':
        // INT goes in as a keystroke: the agent is the foreground job of a
        // shell inside the pty, so a signal to the pty's leader would miss it.
        if (message.name === 'INT') ptyWrite('\u0003');
        else ptyKill(`SIG${message.name}`);
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
          if (text.length > 0) ptyWrite(text);
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

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
  } catch (err) {
    killOrphan();
    await removePtySession(spec.managerId, spec.baseDir).catch(() => {});
    throw err;
  }
  await chmod(socketPath, 0o600).catch(() => {});

  const reaper = setInterval(() => {
    const now = Date.now();
    // A connected holder is live by definition; only a gone one ages out.
    for (const client of clients) {
      if (client.authed && client.id && leases.has(client.id)) {
        leases.set(client.id, { lastSeenAt: now });
      }
    }
    if (spec.lifetime === 'persistent' || !everLeased || pinned || stopping) return;
    for (const lease of leases.values()) {
      if (now - lease.lastSeenAt <= leaseGraceMs) return;
    }
    // Someone is still looking at it. A lease says "this session is mine to
    // reap", never "nobody else may be here": a terminal attached by hand holds
    // none, and SIGHUPing the agent out from under it would be the worst
    // possible reading of a client quitting elsewhere.
    if (watchers() > 0) return;
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
