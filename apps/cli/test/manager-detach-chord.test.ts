import { describe, expect, it } from 'vitest';
import { DetachChord, describeDetachKey, parseDetachKey } from '../src/manager/detach-chord.js';

const bytes = (...v: number[]): Uint8Array => new Uint8Array(v);
const feed = (chord: DetachChord, ...v: number[]) => chord.feed(bytes(...v));

describe('parseDetachKey', () => {
  it('maps a C-<char> spec onto its control byte', () => {
    expect(parseDetachKey('C-]')).toBe(0x1d);
    expect(parseDetachKey('C-a')).toBe(0x01);
    expect(parseDetachKey('ctrl-\\')).toBe(0x1c);
  });

  it('defaults to C-] and honours none', () => {
    expect(parseDetachKey(undefined)).toBe(0x1d);
    expect(parseDetachKey('none')).toBeNull();
    expect(parseDetachKey('')).toBeNull();
  });

  it('refuses a spec it cannot encode rather than guessing', () => {
    expect(parseDetachKey('F5')).toBeNull();
    expect(parseDetachKey('C-é')).toBeNull();
  });
});

describe('DetachChord', () => {
  it('forwards everything but the leader', () => {
    const chord = new DetachChord(0x1d);
    expect(feed(chord, 0x61, 0x62, 0x03)).toEqual({
      forward: bytes(0x61, 0x62, 0x03),
      detach: false,
    });
  });

  it('detaches on leader then d', () => {
    const chord = new DetachChord(0x1d);
    expect(feed(chord, 0x1d).detach).toBe(false);
    expect(feed(chord, 0x64).detach).toBe(true);
  });

  it('sends one literal leader when it is pressed twice', () => {
    const chord = new DetachChord(0x1d);
    feed(chord, 0x1d);
    expect(feed(chord, 0x1d)).toEqual({ forward: bytes(0x1d), detach: false });
  });

  it('types both keys when the chord is mistyped, swallowing nothing', () => {
    const chord = new DetachChord(0x1d);
    feed(chord, 0x1d);
    expect(feed(chord, 0x7a)).toEqual({ forward: bytes(0x1d, 0x7a), detach: false });
  });

  it('handles a chord split across two reads', () => {
    const chord = new DetachChord(0x1d);
    expect(chord.feed(bytes(0x61, 0x1d)).forward).toEqual(bytes(0x61));
    expect(chord.feed(bytes(0x64)).detach).toBe(true);
  });

  it('forwards the leader untouched when the chord is off', () => {
    const chord = new DetachChord(null);
    expect(feed(chord, 0x1d, 0x64)).toEqual({ forward: bytes(0x1d, 0x64), detach: false });
  });

  it('describes itself for the lead-in line', () => {
    expect(describeDetachKey(0x1d, 'C-]')).toBe('C-] d');
    expect(describeDetachKey(null, 'none')).toBe('');
  });
});
