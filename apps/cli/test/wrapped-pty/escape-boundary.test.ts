import { describe, expect, it } from 'vitest';
import {
  appendTail,
  endsMidEscape,
  ESCAPE_TAIL_BYTES,
} from '../../src/wrapped-pty/escape-boundary.js';

describe('endsMidEscape', () => {
  it('treats plain text and completed sequences as safe', () => {
    expect(endsMidEscape('')).toBe(false);
    expect(endsMidEscape('hello world')).toBe(false);
    expect(endsMidEscape('\x1b[0m')).toBe(false);
    expect(endsMidEscape('\x1b[38;5;196mred\x1b[0m')).toBe(false);
    expect(endsMidEscape('\x1b[1;44r')).toBe(false);
  });

  it('flags a CSI whose final byte has not arrived', () => {
    // The exact split a transport produces mid-colour-change.
    expect(endsMidEscape('text \x1b[38;5')).toBe(true);
    expect(endsMidEscape('\x1b[')).toBe(true);
    expect(endsMidEscape('\x1b[1;')).toBe(true);
    // …and clears once it does.
    expect(endsMidEscape('text \x1b[38;5;196m')).toBe(false);
  });

  it('flags a bare ESC', () => {
    expect(endsMidEscape('done\x1b')).toBe(true);
  });

  it('treats two-byte escapes as complete once the second byte is present', () => {
    expect(endsMidEscape('\x1b7')).toBe(false); // DECSC
    expect(endsMidEscape('\x1b8')).toBe(false); // DECRC
    expect(endsMidEscape('\x1b=')).toBe(false);
  });

  it('flags a string sequence until BEL or ST closes it', () => {
    expect(endsMidEscape('\x1b]0;my title')).toBe(true);
    expect(endsMidEscape('\x1b]0;my title\x07')).toBe(false);
    expect(endsMidEscape('\x1b]0;my title\x1b\\')).toBe(false);
    expect(endsMidEscape('\x1bP+q544e')).toBe(true);
    expect(endsMidEscape('\x1bP+q544e\x1b\\')).toBe(false);
  });

  it('only judges the LAST escape — earlier complete ones do not mask it', () => {
    expect(endsMidEscape('\x1b[0mplain\x1b[38;5')).toBe(true);
    expect(endsMidEscape('\x1b[38;5;196m\x1b[0m')).toBe(false);
  });
});

describe('appendTail', () => {
  it('keeps only the trailing window', () => {
    const tail = appendTail('x'.repeat(200), 'abc');
    expect(tail).toHaveLength(ESCAPE_TAIL_BYTES);
    expect(tail.endsWith('abc')).toBe(true);
  });

  it('reconstructs a sequence split across chunks', () => {
    // Two arrivals that individually look like nonsense; together they are a
    // complete CSI, and only the joined view can tell.
    let tail = appendTail('', 'row \x1b[38');
    expect(endsMidEscape(tail)).toBe(true);
    tail = appendTail(tail, ';5;196m');
    expect(endsMidEscape(tail)).toBe(false);
  });
});
