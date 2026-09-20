/**
 * Attach this terminal to a manager's pty-host.
 *
 * A raw proxy and nothing else: stdin goes to the session as bytes, session
 * output goes to stdout as bytes. Nothing is parsed, nothing is rewritten, no
 * status row is drawn — so scrollback, selection, mouse and the modified Enter
 * all belong to the terminal the user is actually looking at. Modeled on the
 * e2b attach helper, which bridges a pty over a non-socket transport the same
 * way.
 */
import { connect, type Socket } from 'node:net';
import {
  PTY_PROTOCOL_VERSION,
  PtyFrameDecoder,
  encodeCtrl,
  encodeInput,
  type PtyClientKind,
  type PtyCtrlFromHost,
} from '@agentbox/core';
import { readPtyMeta } from '@agentbox/sandbox-core';
import {
  DEFAULT_DETACH_KEY,
  DetachChord,
  describeDetachKey,
  parseDetachKey,
} from './detach-chord.js';

export interface PtyAttachOptions {
  managerId: string;
  baseDir?: string;
  /** Stable per-installation id: a lease is re-claimed by whoever holds this. */
  clientId: string;
  kind: PtyClientKind;
  /** Hold a lease, so the session is reaped once this client stays gone. */
  lease?: { ttlMs: number };
  /** No lead-in line and no detach chord — for a client whose window is the detach. */
  raw?: boolean;
  detachKey?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export type PtyAttachResult =
  | { outcome: 'detached' }
  | { outcome: 'exited'; code: number }
  | { outcome: 'unavailable'; reason: string };

export async function attachPtySession(opts: PtyAttachOptions): Promise<PtyAttachResult> {
  const meta = await readPtyMeta(opts.managerId, opts.baseDir);
  if (!meta) return { outcome: 'unavailable', reason: 'no pty session on this machine' };

  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const leader = opts.raw ? null : parseDetachKey(opts.detachKey);
  const chord = new DetachChord(leader);

  const socket = await openSocket(meta.socket);
  if (!socket)
    return { outcome: 'unavailable', reason: `pty host is not listening (${meta.socket})` };

  return await new Promise<PtyAttachResult>((resolve) => {
    const decoder = new PtyFrameDecoder();
    let settled = false;
    let lastExit: number | undefined;
    let rawSet = false;
    let leaseTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (leaseTimer) clearInterval(leaseTimer);
      stdin.off('data', onStdin);
      stdout.off('resize', onResize);
      process.off('SIGINT', onSigint);
      if (rawSet && stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
      stdin.pause();
      socket.destroy();
    };
    const finish = (result: PtyAttachResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onStdin = (chunk: Buffer): void => {
      const step = chord.feed(new Uint8Array(chunk));
      if (step.forward.length > 0) socket.write(encodeInput(step.forward));
      if (step.detach) finish({ outcome: 'detached' });
    };
    const onResize = (): void => {
      socket.write(
        encodeCtrl({ t: 'resize', cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 }),
      );
    };
    // In raw mode Ctrl-C arrives as a byte, not a signal; this is for the case
    // where it does not (a non-TTY stdin), where dying would be wrong — the
    // interrupt belongs to the agent, not to the proxy.
    const onSigint = (): void => {
      socket.write(encodeInput(new Uint8Array([0x03])));
    };

    socket.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = decoder.push(new Uint8Array(chunk));
      } catch (err) {
        finish({ outcome: 'unavailable', reason: (err as Error).message });
        return;
      }
      for (const frame of frames) {
        if (frame.type === 'data') {
          stdout.write(Buffer.from(frame.payload));
          continue;
        }
        if (frame.type === 'exit') {
          lastExit = frame.code;
          continue;
        }
        if (frame.type !== 'ctrl') continue;
        const message = frame.message as PtyCtrlFromHost;
        if (message.t === 'error') {
          finish({ outcome: 'unavailable', reason: `${message.code}: ${message.message}` });
          return;
        }
        if (message.t !== 'welcome') continue;
        if (!opts.raw && leader !== null) {
          stderr.write(
            `attached to manager ${opts.managerId} · ${describeDetachKey(leader, opts.detachKey ?? DEFAULT_DETACH_KEY)} to detach\n`,
          );
        }
        if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
          stdin.setRawMode(true);
          rawSet = true;
        }
        stdin.resume();
        stdin.on('data', onStdin);
        stdout.on('resize', onResize);
        process.on('SIGINT', onSigint);
        if (opts.lease) {
          leaseTimer = setInterval(
            () => {
              socket.write(encodeCtrl({ t: 'lease', ttlMs: opts.lease?.ttlMs ?? 30_000 }));
            },
            Math.max(1_000, Math.floor((opts.lease.ttlMs ?? 30_000) / 3)),
          );
          leaseTimer.unref();
        }
      }
    });
    socket.on('error', (err) => finish({ outcome: 'unavailable', reason: err.message }));
    socket.on('close', () => finish({ outcome: 'exited', code: lastExit ?? 0 }));

    socket.write(
      encodeCtrl({
        t: 'hello',
        v: PTY_PROTOCOL_VERSION,
        token: meta.token,
        client: {
          id: opts.clientId,
          kind: opts.kind,
          cols: stdout.columns ?? meta.cols,
          rows: stdout.rows ?? meta.rows,
        },
        ...(opts.lease ? { lease: { hold: true, ttlMs: opts.lease.ttlMs } } : {}),
        replay: true,
      }),
    );
  });
}

async function openSocket(path: string): Promise<Socket | undefined> {
  return await new Promise<Socket | undefined>((resolve) => {
    const socket = connect(path);
    const onError = (): void => {
      socket.destroy();
      resolve(undefined);
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}
