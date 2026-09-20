/**
 * The hub's side of a manager pty host: pure `node:net` plus the frame codec.
 *
 * Deliberately no node-pty and no raw streaming. The hub only ever needs to
 * ask a session questions and type into it, and its standalone bundle ships no
 * `node_modules` — so the one thing this file must never do is import the
 * optional native prebuild. Raw attach is the CLI's job.
 */
import { connect, type Socket } from 'node:net';
import {
  PTY_PROTOCOL_VERSION,
  PtyFrameDecoder,
  encodeCtrl,
  type PtyCtrlFromClient,
  type PtyCtrlFromHost,
} from '@agentbox/core';
import type { PtySessionMeta } from '@agentbox/sandbox-core';

const CONNECT_TIMEOUT_MS = 1_500;
const REPLY_TIMEOUT_MS = 5_000;

export interface PtyHostStatus {
  pid: number;
  clients: number;
  leaseHolders: string[];
  pinned: boolean;
  idleMs: number;
  cols: number;
  rows: number;
}

/** Is a host serving this socket? The liveness probe `tmux has-session` used to be. */
export async function ptyHostAlive(socket: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const sock = connect(socket);
    const done = (alive: boolean): void => {
      sock.destroy();
      resolve(alive);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), CONNECT_TIMEOUT_MS).unref();
  });
}

interface Session {
  send(message: PtyCtrlFromClient): void;
  /** Resolves with the first host message of this type, or undefined on timeout. */
  reply(t: PtyCtrlFromHost['t'], ms?: number): Promise<PtyCtrlFromHost | undefined>;
}

/**
 * Connect, say hello, run `fn`, always close. Returns undefined when the host
 * is gone or refuses us — every caller treats that as "the session is not
 * there", which is the same thing a failed `tmux has-session` meant.
 */
export async function withPtyHost<T>(
  meta: Pick<PtySessionMeta, 'socket' | 'token'>,
  fn: (session: Session) => Promise<T>,
): Promise<T | undefined> {
  const socket = await open(meta.socket);
  if (!socket) return undefined;
  const decoder = new PtyFrameDecoder();
  type Waiter = { t: string; resolve: (m: PtyCtrlFromHost | undefined) => void };
  const waiters: Waiter[] = [];
  const seen: PtyCtrlFromHost[] = [];

  socket.on('data', (chunk: Buffer) => {
    let frames;
    try {
      frames = decoder.push(new Uint8Array(chunk));
    } catch {
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (frame.type !== 'ctrl') continue;
      const message = frame.message as PtyCtrlFromHost;
      seen.push(message);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i] as Waiter;
        if (waiter.t !== message.t) continue;
        waiters.splice(i, 1);
        waiter.resolve(message);
      }
    }
  });
  socket.on('error', () => socket.destroy());

  const session: Session = {
    send: (message) => {
      if (!socket.destroyed) socket.write(encodeCtrl(message));
    },
    reply: async (t, ms = REPLY_TIMEOUT_MS) => {
      const already = seen.find((m) => m.t === t);
      if (already) return already;
      return await new Promise<PtyCtrlFromHost | undefined>((resolve) => {
        const waiter: Waiter = { t, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) waiters.splice(at, 1);
          resolve(undefined);
        }, ms).unref();
      });
    },
  };

  try {
    session.send({
      t: 'hello',
      v: PTY_PROTOCOL_VERSION,
      token: meta.token,
      client: { id: 'hub', kind: 'hub', cols: 0, rows: 0 },
      // The hub wants the session, not its screen: no replay, and a zero size
      // so it never wins the size arbitration away from a real terminal.
      replay: false,
    });
    const welcome = await session.reply('welcome');
    if (!welcome) return undefined;
    return await fn(session);
  } finally {
    socket.destroy();
  }
}

export async function ptyStatus(
  meta: Pick<PtySessionMeta, 'socket' | 'token'>,
): Promise<PtyHostStatus | undefined> {
  return await withPtyHost(meta, async (session) => {
    session.send({ t: 'status' });
    const report = await session.reply('status-report');
    if (report?.t !== 'status-report') return undefined;
    const { pid, clients, leaseHolders, pinned, idleMs, cols, rows } = report;
    return { pid, clients, leaseHolders, pinned, idleMs, cols, rows };
  });
}

/**
 * Type a message into the session and submit it — what `tmux send-keys` did.
 * The status round-trip afterwards is the acknowledgement: the host has the
 * frames, so closing the connection cannot drop them.
 */
export async function ptyInject(
  meta: Pick<PtySessionMeta, 'socket' | 'token'>,
  text: string,
  submitDelayMs?: number,
): Promise<boolean> {
  const ok = await withPtyHost(meta, async (session) => {
    session.send({
      t: 'inject',
      text,
      submit: true,
      ...(submitDelayMs === undefined ? {} : { submitDelayMs }),
    });
    session.send({ t: 'status' });
    return (await session.reply('status-report'))?.t === 'status-report';
  });
  return ok === true;
}

export async function ptyStop(meta: Pick<PtySessionMeta, 'socket' | 'token'>): Promise<boolean> {
  const ok = await withPtyHost(meta, async (session) => {
    session.send({ t: 'stop' });
    // The host answers by closing; a status reply means it is still killing.
    await session.reply('status-report', 1_000);
    return true;
  });
  return ok === true;
}

export async function ptyConfigure(
  meta: Pick<PtySessionMeta, 'socket' | 'token'>,
  patch: { pinned?: boolean; leaseGraceMs?: number },
): Promise<boolean> {
  const ok = await withPtyHost(meta, async (session) => {
    session.send({ t: 'configure', ...patch });
    session.send({ t: 'status' });
    return (await session.reply('status-report'))?.t === 'status-report';
  });
  return ok === true;
}

async function open(path: string): Promise<Socket | undefined> {
  return await new Promise<Socket | undefined>((resolve) => {
    const socket = connect(path);
    const fail = (): void => {
      socket.destroy();
      resolve(undefined);
    };
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.off('error', fail);
      socket.setNoDelay(true);
      resolve(socket);
    });
    setTimeout(fail, CONNECT_TIMEOUT_MS).unref();
  });
}
