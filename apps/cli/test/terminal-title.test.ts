import { describe, expect, it } from 'vitest';
import {
  popTerminalTitle,
  pushTerminalTitle,
  setTerminalTitle,
} from '../src/terminal/title.js';

/** Minimal WriteStream stub capturing writes, with a settable `isTTY`. */
function fakeStream(isTTY: boolean): { isTTY: boolean; out: string[] } & NodeJS.WriteStream {
  const out: string[] = [];
  return {
    isTTY,
    out,
    write: (chunk: string) => {
      out.push(chunk);
      return true;
    },
  } as unknown as { isTTY: boolean; out: string[] } & NodeJS.WriteStream;
}

describe('setTerminalTitle', () => {
  it('emits OSC 0 with BEL terminator on a TTY', () => {
    const s = fakeStream(true);
    setTerminalTitle('hi', s);
    expect(s.out).toEqual(['\x1b]0;hi\x07']);
  });

  it('writes nothing when the stream is not a TTY', () => {
    const s = fakeStream(false);
    setTerminalTitle('hi', s);
    expect(s.out).toEqual([]);
  });

  it('strips control chars that would break the OSC string', () => {
    const s = fakeStream(true);
    setTerminalTitle('a\nb\x07c', s);
    expect(s.out).toEqual(['\x1b]0;a b c\x07']);
  });

  it('trims surrounding whitespace', () => {
    const s = fakeStream(true);
    setTerminalTitle('  spaced  ', s);
    expect(s.out).toEqual(['\x1b]0;spaced\x07']);
  });
});

describe('push/popTerminalTitle', () => {
  it('emits the XTPUSHTITLE / XTPOPTITLE CSI on a TTY', () => {
    const s = fakeStream(true);
    pushTerminalTitle(s);
    popTerminalTitle(s);
    expect(s.out).toEqual(['\x1b[22;2t', '\x1b[23;2t']);
  });

  it('writes nothing when the stream is not a TTY', () => {
    const s = fakeStream(false);
    pushTerminalTitle(s);
    popTerminalTitle(s);
    expect(s.out).toEqual([]);
  });
});
