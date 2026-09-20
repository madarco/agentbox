/**
 * Wire protocol between a manager's pty-host and its clients (the CLI attach
 * proxy, the tray's ghostty surface, the hub).
 *
 * Length-prefixed binary, not JSON lines: pty output is arbitrary bytes — a
 * chunk can split a UTF-8 sequence, and mouse reports or a pasted image contain
 * any byte at all. Byte-exactness IS the feature here (every transcoding hop is
 * a place a modifier gets dropped, which is the bug this carrier exists to
 * fix), and it keeps a future WebSocket bridge a pure relay: DATA/INPUT map to
 * binary frames, CTRL to text frames, nothing re-encodes.
 */

export const PTY_PROTOCOL_VERSION = 1;

/** Frame type bytes. */
export const PTY_FRAME = {
  data: 0x01,
  input: 0x02,
  ctrl: 0x03,
  exit: 0x04,
} as const;

/**
 * A single frame may not exceed this. Output is chunked by the pty long before
 * this, so a larger length means a desynced stream (or a hostile peer) and the
 * connection is dropped rather than buffered.
 */
export const PTY_MAX_FRAME = 1024 * 1024;

export type PtyClientKind = 'cli' | 'tray' | 'hub' | 'bridge';

export interface PtyClientHello {
  id: string;
  kind: PtyClientKind;
  cols: number;
  rows: number;
}

/** Client to host. */
export type PtyCtrlFromClient =
  | {
      t: 'hello';
      v: number;
      token: string;
      client: PtyClientHello;
      lease?: { hold: boolean; ttlMs: number };
      replay?: boolean;
    }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'inject'; text: string; submit?: boolean; submitDelayMs?: number }
  | { t: 'lease'; ttlMs: number }
  | { t: 'release' }
  | { t: 'stop'; reason?: string }
  | { t: 'signal'; name: 'INT' | 'TERM' | 'HUP' }
  | { t: 'status' }
  | { t: 'configure'; pinned?: boolean; leaseGraceMs?: number; windowSize?: PtyWindowSize }
  | { t: 'bye' };

/** Host to client. */
export type PtyCtrlFromHost =
  | {
      t: 'welcome';
      v: number;
      managerId: string;
      agent?: string;
      cwd: string;
      cols: number;
      rows: number;
      clients: number;
      exited?: number;
    }
  | { t: 'replay-begin'; bytes: number }
  | { t: 'replay-end' }
  | { t: 'size'; cols: number; rows: number; by: string }
  | { t: 'lease-ack'; expiresAt: string }
  | {
      t: 'status-report';
      managerId: string;
      pid: number;
      clients: number;
      leaseHolders: string[];
      pinned: boolean;
      idleMs: number;
      cols: number;
      rows: number;
    }
  | { t: 'error'; code: PtyErrorCode; message: string };

export type PtyCtrl = PtyCtrlFromClient | PtyCtrlFromHost;

export type PtyWindowSize = 'latest' | 'smallest' | 'largest';

export type PtyErrorCode =
  | 'unauthorized'
  | 'bad-frame'
  | 'bad-message'
  | 'unsupported-version'
  | 'not-permitted';

export type PtyFrame =
  | { type: 'data'; payload: Uint8Array }
  | { type: 'input'; payload: Uint8Array }
  | { type: 'ctrl'; message: PtyCtrl }
  | { type: 'exit'; code: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

export function encodeData(payload: Uint8Array): Uint8Array {
  return frame(PTY_FRAME.data, payload);
}

export function encodeInput(payload: Uint8Array): Uint8Array {
  return frame(PTY_FRAME.input, payload);
}

export function encodeCtrl(message: PtyCtrl): Uint8Array {
  return frame(PTY_FRAME.ctrl, encoder.encode(JSON.stringify(message)));
}

export function encodeExit(code: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, code >>> 0, false);
  return frame(PTY_FRAME.exit, payload);
}

export class PtyFrameError extends Error {
  readonly code: PtyErrorCode;
  constructor(code: PtyErrorCode, message: string) {
    super(message);
    this.name = 'PtyFrameError';
    this.code = code;
  }
}

/**
 * Incremental decoder. A socket hands over arbitrary chunk boundaries, so a
 * frame header can arrive split across two reads and several frames can arrive
 * in one; `push` returns whatever is complete and keeps the remainder.
 */
export class PtyFrameDecoder {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): PtyFrame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const frames: PtyFrame[] = [];
    for (;;) {
      if (this.buf.length < 5) break;
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const len = view.getUint32(1, false);
      if (len > PTY_MAX_FRAME) {
        throw new PtyFrameError('bad-frame', `frame of ${len} bytes exceeds ${PTY_MAX_FRAME}`);
      }
      if (this.buf.length < 5 + len) break;
      const type = this.buf[0];
      const payload = this.buf.slice(5, 5 + len);
      this.buf = this.buf.slice(5 + len);
      frames.push(decodeFrame(type ?? 0, payload));
    }
    return frames;
  }
}

function decodeFrame(type: number, payload: Uint8Array): PtyFrame {
  switch (type) {
    case PTY_FRAME.data:
      return { type: 'data', payload };
    case PTY_FRAME.input:
      return { type: 'input', payload };
    case PTY_FRAME.ctrl: {
      const message = parsePtyCtrl(payload);
      if (!message) throw new PtyFrameError('bad-message', 'ctrl frame is not a known message');
      return { type: 'ctrl', message };
    }
    case PTY_FRAME.exit: {
      if (payload.length !== 4) throw new PtyFrameError('bad-frame', 'exit frame must be 4 bytes');
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      return { type: 'exit', code: view.getUint32(0, false) };
    }
    default:
      throw new PtyFrameError('bad-frame', `unknown frame type 0x${type.toString(16)}`);
  }
}

const CLIENT_TAGS = new Set([
  'hello',
  'resize',
  'inject',
  'lease',
  'release',
  'stop',
  'signal',
  'status',
  'configure',
  'bye',
]);
const HOST_TAGS = new Set([
  'welcome',
  'replay-begin',
  'replay-end',
  'size',
  'lease-ack',
  'status-report',
  'error',
]);

/**
 * Parse a ctrl payload into a known message. Returns undefined for anything
 * unrecognized — a peer speaking a newer protocol must not be able to steer an
 * older host through a field it does not understand.
 */
export function parsePtyCtrl(payload: Uint8Array | string): PtyCtrl | undefined {
  let value: unknown;
  try {
    value = JSON.parse(typeof payload === 'string' ? payload : decoder.decode(payload));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const tag = (value as { t?: unknown }).t;
  if (typeof tag !== 'string') return undefined;
  if (!CLIENT_TAGS.has(tag) && !HOST_TAGS.has(tag)) return undefined;
  if (tag === 'hello' && !isHello(value)) return undefined;
  return value as PtyCtrl;
}

function isHello(value: object): boolean {
  const v = value as Partial<Extract<PtyCtrlFromClient, { t: 'hello' }>>;
  if (typeof v.v !== 'number' || typeof v.token !== 'string') return false;
  const c = v.client;
  return (
    !!c && typeof c.id === 'string' && typeof c.cols === 'number' && typeof c.rows === 'number'
  );
}
