/**
 * Regression for agent-box/agentbox#260 — "status band corrupts on scroll".
 *
 * The wrapper forwards the inner program's bytes and then writes its own
 * chrome after them. A transport is free to split that stream anywhere, so a
 * chunk can end halfway through a CSI; chrome written there is spliced into
 * the sequence, and what the terminal makes of the result is anyone's guess —
 * a dropped colour run, a swallowed repaint, or wrapper bytes printed as
 * literal characters in the content area.
 *
 * Measured on a live box (tmux scrolling, 15s, 143x45): docker split the
 * stream into 81 chunks with 1.2% of boundaries mid-sequence, while sprites
 * split it into 5793 chunks with 19.6% mid-sequence — and the wrapper
 * repainted after every one of them.
 *
 * So the invariant is about the chunking, not the renderer: chrome must only
 * ever be written where the forwarded stream has no sequence open, whatever
 * size the pieces arrive in.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { appendTail, endsMidEscape } from '../../src/wrapped-pty/escape-boundary.js';

// @xterm/headless is CJS; a static ESM named import breaks Node's loader for
// the whole CLI (same dance as src/pty/pty-backend.ts).
const require = createRequire(import.meta.url);
interface Line {
  translateToString(trim: boolean): string;
}
const { Terminal } = require('@xterm/headless') as {
  Terminal: new (o: {
    cols: number;
    rows: number;
    allowProposedApi: boolean;
    scrollback: number;
    convertEol: boolean;
  }) => {
    write(d: string, cb?: () => void): void;
    buffer: { active: { getLine(y: number): Line | undefined } };
  };
};

const COLS = 80;
const ROWS = 24;
const INNER = ROWS - 1; // the wrapper reserves the last row for the footer

const CHROME =
  '\x1b[?2026h\x1b7' +
  `\x1b[${String(ROWS)};1H` +
  '\x1b[7m' +
  ' agentbox  claude:idle '.padEnd(COLS, ' ') +
  '\x1b[0m\x1b8\x1b[?2026l';

/**
 * Content with the escape shapes a TUI actually emits: SGR colour runs, bold,
 * scrolling, and the OSC title updates tmux and the agents push constantly.
 * The OSC matters — it is the shape whose splice can strand wrapper bytes on
 * screen rather than merely dropping them.
 */
function innerStream(): string {
  let s = `\x1b[1;${String(INNER)}r\x1b[H\x1b[2J`;
  for (let i = 1; i <= 40; i++) {
    s += `\x1b]0;pane ${String(i)}\x07`;
    s += `\x1b[38;5;${String(30 + (i % 200))}mline ${String(i)} colored\x1b[0m`;
    s += `\x1b[1m bold\x1b[22m tail\r\n`;
  }
  return s;
}

type Policy = 'none' | 'always' | 'gated';

/** Apply a chrome policy to a chunked stream; report where each write landed. */
function applyPolicy(
  chunks: string[],
  policy: Policy,
): { out: string; chromeWrites: number; writesMidSequence: number } {
  let out = '';
  let tail = '';
  let chromeWrites = 0;
  let writesMidSequence = 0;
  for (const c of chunks) {
    out += c;
    tail = appendTail(tail, c);
    const write = policy === 'always' || (policy === 'gated' && !endsMidEscape(tail));
    if (!write) continue;
    // Judged against the INNER stream only — the question is whether the
    // program's own sequences were all closed at this point.
    if (endsMidEscape(tail)) writesMidSequence++;
    chromeWrites++;
    out += CHROME;
  }
  return { out, chromeWrites, writesMidSequence };
}

function screen(data: string): string[] {
  const term = new Terminal({
    cols: COLS,
    rows: ROWS,
    allowProposedApi: true,
    scrollback: 0,
    convertEol: false,
  });
  term.write(data);
  const out: string[] = [];
  for (let y = 0; y < INNER; y++) {
    out.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '');
  }
  return out;
}

const splitEvery = (s: string, n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
};

describe('chrome writes vs escape-sequence boundaries', () => {
  const stream = innerStream();

  it('the unguarded policy writes chrome inside the program’s sequences', () => {
    // What shipped before the fix, under the chunking a fine-grained transport
    // actually produces. If this ever reaches zero the hazard is gone and the
    // gate below has nothing left to prove.
    const oneByteAtATime = applyPolicy(splitEvery(stream, 1), 'always');
    expect(oneByteAtATime.writesMidSequence).toBeGreaterThan(100);

    const realistic = applyPolicy(splitEvery(stream, 7), 'always');
    expect(realistic.writesMidSequence).toBeGreaterThan(10);
  });

  it('the gate never writes chrome inside a sequence, at any chunk size', () => {
    for (const size of [1, 2, 3, 7, 16, 64, 512]) {
      const r = applyPolicy(splitEvery(stream, size), 'gated');
      expect(r.writesMidSequence, `chunk size ${String(size)}`).toBe(0);
      // …and it still paints: a gate that never fires would also score zero.
      expect(r.chromeWrites, `chunk size ${String(size)}`).toBeGreaterThan(0);
    }
  });

  it('leaves the content area identical to a chrome-free render', () => {
    const clean = screen(stream);
    for (const size of [1, 3, 7, 64]) {
      const gated = applyPolicy(splitEvery(stream, size), 'gated');
      expect(screen(gated.out), `chunk size ${String(size)}`).toEqual(clean);
    }
  });
});
