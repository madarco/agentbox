import { describe, expect, it } from 'vitest';
import {
  PTY_MAX_FRAME,
  PtyFrameDecoder,
  PtyFrameError,
  encodeCtrl,
  encodeData,
  encodeExit,
  encodeInput,
  parsePtyCtrl,
} from '../src/pty-protocol.js';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe('pty frame codec', () => {
  it('round-trips each frame type', () => {
    const decoder = new PtyFrameDecoder();
    const frames = decoder.push(
      new Uint8Array([
        ...encodeData(bytes(1, 2, 3)),
        ...encodeInput(bytes(0x03)),
        ...encodeCtrl({ t: 'resize', cols: 100, rows: 30 }),
        ...encodeExit(7),
      ]),
    );
    expect(frames.map((f) => f.type)).toEqual(['data', 'input', 'ctrl', 'exit']);
    expect(frames[0]).toMatchObject({ payload: bytes(1, 2, 3) });
    expect(frames[2]).toMatchObject({ message: { t: 'resize', cols: 100, rows: 30 } });
    expect(frames[3]).toMatchObject({ code: 7 });
  });

  it('reassembles a frame split across chunks', () => {
    const whole = encodeData(new Uint8Array(300).fill(0x41));
    const decoder = new PtyFrameDecoder();
    expect(decoder.push(whole.slice(0, 2))).toEqual([]);
    expect(decoder.push(whole.slice(2, 7))).toEqual([]);
    const frames = decoder.push(whole.slice(7));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.type === 'data' && frames[0].payload.length).toBe(300);
  });

  it('keeps binary payloads byte-exact', () => {
    // Half of a multi-byte character plus a raw mouse report: the exact shape
    // that a JSON-lines protocol would have mangled.
    const raw = bytes(0xe2, 0x9c, 0x1b, 0x5b, 0x3c, 0x30, 0x3b, 0x31, 0x4d, 0xff);
    const frames = new PtyFrameDecoder().push(encodeData(raw));
    expect(frames[0]?.type === 'data' && frames[0].payload).toEqual(raw);
  });

  it('rejects an oversized frame instead of buffering it', () => {
    const header = new Uint8Array(5);
    header[0] = 0x01;
    new DataView(header.buffer).setUint32(1, PTY_MAX_FRAME + 1, false);
    expect(() => new PtyFrameDecoder().push(header)).toThrow(PtyFrameError);
  });

  it('rejects an unknown frame type', () => {
    expect(() => new PtyFrameDecoder().push(bytes(0x09, 0, 0, 0, 0))).toThrow(/unknown frame type/u);
  });
});

describe('parsePtyCtrl', () => {
  it('accepts a well-formed hello', () => {
    const hello = {
      t: 'hello',
      v: 1,
      token: 'abc',
      client: { id: 'cli:1', kind: 'cli', cols: 80, rows: 24 },
    };
    expect(parsePtyCtrl(JSON.stringify(hello))).toEqual(hello);
  });

  it('refuses a hello missing its client or token', () => {
    expect(parsePtyCtrl('{"t":"hello","v":1,"token":"abc"}')).toBeUndefined();
    expect(
      parsePtyCtrl('{"t":"hello","v":1,"client":{"id":"a","kind":"cli","cols":1,"rows":1}}'),
    ).toBeUndefined();
  });

  it('refuses unknown tags and malformed json', () => {
    expect(parsePtyCtrl('{"t":"exec","cmd":"rm -rf /"}')).toBeUndefined();
    expect(parsePtyCtrl('not json')).toBeUndefined();
    expect(parsePtyCtrl('[]')).toBeUndefined();
  });
});
