import { describe, expect, it } from 'vitest';
import { PtyEscScanner, PtyRing } from '../src/pty-ring.js';
import { Utf8Joiner } from '../src/pty-host.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('PtyEscScanner', () => {
  it('tracks sticky modes a TUI announces once at startup', () => {
    const scanner = new PtyEscScanner();
    scanner.push(enc('\u001b[?1002h\u001b[?1006h\u001b[?2004h hello'));
    const prologue = scanner.modePrologue();
    expect(prologue).toContain('\u001b[?1002h');
    expect(prologue).toContain('\u001b[?1006h');
    expect(prologue).toContain('\u001b[?2004h');
  });

  it('drops a mode that was turned back off', () => {
    const scanner = new PtyEscScanner();
    scanner.push(enc('\u001b[?1002h\u001b[?1002l'));
    expect(scanner.modePrologue()).not.toContain('1002');
  });

  it('understands a sequence split across chunks', () => {
    const scanner = new PtyEscScanner();
    scanner.push(enc('\u001b[?10'));
    scanner.push(enc('02h'));
    expect(scanner.modePrologue()).toContain('\u001b[?1002h');
  });

  it('records key-encoding modes', () => {
    const scanner = new PtyEscScanner();
    scanner.push(enc('\u001b[>4;2m\u001b[>1u'));
    expect(scanner.modePrologue()).toContain('\u001b[>4;2m');
    expect(scanner.modePrologue()).toContain('\u001b[>1u');
  });

  it('marks a safe resume point at a clear and at an alt-screen switch', () => {
    const scanner = new PtyEscScanner();
    scanner.push(enc('junk\u001b[2J'));
    expect(scanner.safeOffset).toBe(scanner.offset);
    scanner.push(enc('frame'));
    expect(scanner.safeOffset).toBeLessThan(scanner.offset);
    scanner.push(enc('\u001b[?1049h'));
    expect(scanner.safeOffset).toBe(scanner.offset);
    expect(scanner.altScreen).toBe(true);
  });
});

describe('PtyRing', () => {
  it('replays from the last screen wipe, not from mid-frame', () => {
    const ring = new PtyRing({ maxBytes: 65536 });
    ring.push(enc('old noise'));
    ring.push(enc('\u001b[2J'));
    ring.push(enc('current frame'));
    const { body } = ring.replay();
    expect(dec(body)).toBe('current frame');
  });

  it('re-enters the alt screen when the agent is in it', () => {
    const ring = new PtyRing({ maxBytes: 65536 });
    ring.push(enc('\u001b[?1049h\u001b[?1002hpainted'));
    const { prologue, body } = ring.replay();
    expect(prologue).toContain('\u001b[?1049h');
    expect(prologue).toContain('\u001b[?1002h');
    // The body resumes just after the alt-screen switch, so a mode set later in
    // the same burst appears twice — setting a mode twice is a no-op.
    expect(dec(body)).toBe('\u001b[?1002hpainted');
  });

  it('caps its memory and still replays what it kept', () => {
    const ring = new PtyRing({ maxBytes: 4096 });
    for (let i = 0; i < 100; i += 1) ring.push(enc('x'.repeat(100)));
    const { body } = ring.replay();
    expect(body.length).toBeLessThanOrEqual(4096);
    expect(dec(body)).toMatch(/^x+$/u);
  });

  it('falls back to a partial frame when the wipe has scrolled out', () => {
    const ring = new PtyRing({ maxBytes: 4096 });
    ring.push(enc('\u001b[2J'));
    for (let i = 0; i < 100; i += 1) ring.push(enc('y'.repeat(100)));
    const { body } = ring.replay();
    expect(body.length).toBeGreaterThan(0);
  });
});

describe('Utf8Joiner', () => {
  it('holds back a character split across two reads', () => {
    const joiner = new Utf8Joiner();
    const full = new TextEncoder().encode('é');
    expect(joiner.push(full.slice(0, 1))).toBe('');
    expect(joiner.push(full.slice(1))).toBe('é');
  });

  it('passes control bytes straight through', () => {
    expect(new Utf8Joiner().push(new Uint8Array([0x03, 0x1b, 0x5b, 0x41]))).toBe('\u0003\u001b[A');
  });

  it('splits a 4-byte emoji correctly', () => {
    const joiner = new Utf8Joiner();
    const full = new TextEncoder().encode('ok 🙂');
    expect(joiner.push(full.slice(0, 5))).toBe('ok ');
    expect(joiner.push(full.slice(5))).toBe('🙂');
  });
});
