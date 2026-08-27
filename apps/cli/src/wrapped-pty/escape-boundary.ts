/**
 * "Is the byte stream we've forwarded so far sitting at a safe place to splice
 * our own escape sequences in?"
 *
 * The wrapper forwards the inner program's bytes to the user's terminal and
 * then writes its own chrome (footer, alert band, scroll region) after them.
 * That is only safe when the forwarded stream ends on a sequence boundary. A
 * PTY read carries no framing guarantee: the transport chops the stream
 * wherever its packets land, so a chunk can end halfway through a CSI —
 * `\x1b[38;5` with the `m` still in flight. Writing chrome there splices our
 * bytes into the inner program's sequence: the terminal consumes the mangled
 * result, and the leftovers land on screen as literal characters.
 *
 * Measured on a live box (tmux scrolling, 15s, 143x45):
 *
 *   docker  `docker exec -it`         81 chunks, median 568B,  1.2% mid-sequence
 *   e2b     SDK PTY bridge           370 chunks, median 422B,  0.5% mid-sequence
 *   sprites `sprite exec --tty`     5793 chunks, median   7B, 19.6% mid-sequence
 *
 * The wrapper repainted after every one of those chunks, so on sprites ~1100
 * of its own writes per 15 seconds landed inside someone else's escape
 * sequence. Hence agent-box/agentbox#260 ("garbled on sprites, occasional
 * artifacts elsewhere") — same bug everywhere, scaled by chunk granularity.
 */

/**
 * Longest tail we need to keep to answer the question. An unterminated CSI is
 * the common case and is short; a long OSC (a title string) can exceed this,
 * in which case we conservatively report "unsafe" only while the ESC is still
 * within the window. Overshooting costs a deferred repaint, never corruption
 * of the content area, so a small window is the right trade.
 */
export const ESCAPE_TAIL_BYTES = 64;

/**
 * True when `tail` (the last {@link ESCAPE_TAIL_BYTES} of the forwarded
 * stream) ends inside an escape sequence the inner program has not finished
 * emitting.
 *
 * Recognizes the four shapes a split can leave dangling:
 *  - a bare `ESC` with nothing after it;
 *  - `CSI` (`ESC [`) whose final byte (0x40–0x7E) hasn't arrived;
 *  - a string sequence (`OSC`/`DCS`/`PM`/`APC`) with no `BEL` or `ST` yet;
 *  - everything else is a two-byte escape (`ESC 7`, `ESC 8`, `ESC =`, …),
 *    complete as soon as its second byte is present.
 */
export function endsMidEscape(tail: string): boolean {
  const esc = tail.lastIndexOf('\x1b');
  if (esc < 0) return false;
  const seq = tail.slice(esc);
  if (seq.length === 1) return true;

  const kind = seq[1];
  if (kind === '[') {
    for (let i = 2; i < seq.length; i++) {
      const b = seq.charCodeAt(i);
      if (b >= 0x40 && b <= 0x7e) return false;
    }
    return true;
  }
  if (kind === ']' || kind === 'P' || kind === '^' || kind === '_') {
    for (let i = 2; i < seq.length; i++) {
      if (seq.charCodeAt(i) === 0x07) return false; // BEL
      if (seq[i] === '\x1b' && seq[i + 1] === '\\') return false; // ST
    }
    return true;
  }
  return false;
}

/** Append `chunk` to `tail`, keeping only the bytes {@link endsMidEscape} needs. */
export function appendTail(tail: string, chunk: string): string {
  return (tail + chunk).slice(-ESCAPE_TAIL_BYTES);
}
