/**
 * The replay buffer behind "attach and see what the agent is doing".
 *
 * tmux could repaint a late attacher because it parsed every byte into a screen
 * model. Owning the pty instead means the host forwards raw bytes, so a client
 * that connects after the agent started has missed both the screen AND the
 * one-shot mode announcements (mouse reporting, bracketed paste, key encoding)
 * that a TUI emits once at startup and never repeats — without them the mouse
 * and paste are dead for that client.
 *
 * So the ring keeps recent output plus two derived facts: the last point in the
 * stream where the screen was wiped (replaying from there is a clean frame, not
 * half of one) and the sticky mode set currently in force.
 */

const ESC = 0x1b;

/** DEC private modes worth re-asserting for a late attacher. */
const STICKY_DEC_MODES = new Set([
  1, // DECCKM — application cursor keys
  7, // auto-wrap
  12, // cursor blink
  25, // cursor visible
  1000, // mouse: press/release
  1002, // mouse: button-drag tracking
  1003, // mouse: any-motion tracking
  1004, // focus reporting
  1005, // mouse: utf-8 coords
  1006, // mouse: SGR coords
  1015, // mouse: urxvt coords
  2004, // bracketed paste
]);

const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

type ScanState = 'text' | 'esc' | 'csi';

/**
 * Streaming scanner over pty output. Fed byte by byte so a sequence split
 * across two chunks is still understood — the split is the common case, not the
 * edge case, since a chunk boundary falls wherever the kernel decided.
 */
export class PtyEscScanner {
  private state: ScanState = 'text';
  private params: number[] = [];
  private paramDigits = '';
  private prefix = '';
  private readonly decModes = new Set<number>();
  private modifyOtherKeys?: string;
  private kittyKeyboard?: string;

  /** Absolute stream offset just past the last full-screen wipe. */
  safeOffset = 0;
  /** Absolute count of bytes ever fed. */
  offset = 0;
  altScreen = false;

  push(chunk: Uint8Array): void {
    for (const byte of chunk) {
      this.offset += 1;
      this.step(byte);
    }
  }

  /** The sticky modes, as the bytes needed to put a fresh client into them. */
  modePrologue(): string {
    let out = '';
    if (this.altScreen) out += '\u001b[?1049h';
    for (const mode of this.decModes) {
      if (ALT_SCREEN_MODES.has(mode)) continue;
      out += `\u001b[?${mode}h`;
    }
    if (this.modifyOtherKeys) out += this.modifyOtherKeys;
    if (this.kittyKeyboard) out += this.kittyKeyboard;
    return out;
  }

  private step(byte: number): void {
    if (this.state === 'text') {
      if (byte === ESC) this.state = 'esc';
      return;
    }
    if (this.state === 'esc') {
      if (byte === 0x5b) {
        this.state = 'csi';
        this.params = [];
        this.paramDigits = '';
        this.prefix = '';
        return;
      }
      // RIS (ESC c) wipes everything: the cleanest resume point there is.
      if (byte === 0x63) this.markSafe();
      this.state = byte === ESC ? 'esc' : 'text';
      return;
    }
    // CSI: collect prefix/params until a final byte in 0x40..0x7e.
    if (byte >= 0x30 && byte <= 0x39) {
      this.paramDigits += String.fromCharCode(byte);
      return;
    }
    if (byte === 0x3b) {
      this.pushParam();
      return;
    }
    if (byte === 0x3f || byte === 0x3e || byte === 0x3c || byte === 0x3d) {
      this.prefix = String.fromCharCode(byte);
      return;
    }
    if (byte >= 0x20 && byte <= 0x2f) return; // intermediate bytes
    if (byte >= 0x40 && byte <= 0x7e) {
      this.pushParam();
      this.final(String.fromCharCode(byte));
      this.state = 'text';
      return;
    }
    this.state = 'text';
  }

  private pushParam(): void {
    if (this.paramDigits.length > 0) {
      this.params.push(Number(this.paramDigits));
      this.paramDigits = '';
    } else if (this.prefix !== '' || this.params.length > 0) {
      this.params.push(0);
    }
  }

  private final(ch: string): void {
    if (this.prefix === '?' && (ch === 'h' || ch === 'l')) {
      const on = ch === 'h';
      for (const mode of this.params) {
        if (ALT_SCREEN_MODES.has(mode)) {
          this.altScreen = on;
          this.markSafe();
        }
        if (!STICKY_DEC_MODES.has(mode) && !ALT_SCREEN_MODES.has(mode)) continue;
        if (on) this.decModes.add(mode);
        else this.decModes.delete(mode);
      }
      return;
    }
    if (this.prefix === '>' && ch === 'm') {
      const [mode, level] = this.params;
      if (mode === 4) {
        this.modifyOtherKeys = level === undefined ? '\u001b[>4m' : `\u001b[>4;${level}m`;
      }
      return;
    }
    if (this.prefix === '>' && ch === 'u') {
      this.kittyKeyboard = `\u001b[>${this.params[0] ?? 1}u`;
      return;
    }
    if (this.prefix === '' && ch === 'J' && (this.params[0] === 2 || this.params[0] === 3)) {
      this.markSafe();
    }
  }

  private markSafe(): void {
    this.safeOffset = this.offset;
  }
}

export interface PtyRingOptions {
  maxBytes: number;
}

/** Recent pty output, capped, with the scanner's view of where to resume. */
export class PtyRing {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  /** Absolute offset of the first byte still retained. */
  private dropped = 0;
  private readonly scanner = new PtyEscScanner();
  private readonly maxBytes: number;

  constructor(opts: PtyRingOptions) {
    this.maxBytes = Math.max(4096, opts.maxBytes);
  }

  get altScreen(): boolean {
    return this.scanner.altScreen;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.scanner.push(chunk);
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0];
      if (!head) break;
      const excess = this.bytes - this.maxBytes;
      if (head.length <= excess) {
        this.chunks.shift();
        this.bytes -= head.length;
        this.dropped += head.length;
      } else {
        this.chunks[0] = head.slice(excess);
        this.bytes -= excess;
        this.dropped += excess;
      }
    }
  }

  /**
   * What a fresh client should be sent: the sticky modes, then output from the
   * last screen wipe (or from whatever is left, when that wipe has already
   * scrolled out of the ring — a partial frame still beats a blank window).
   */
  replay(): { prologue: string; body: Uint8Array } {
    const from = Math.max(this.scanner.safeOffset, this.dropped);
    const skip = from - this.dropped;
    const body = this.concat(skip);
    return { prologue: this.scanner.modePrologue(), body };
  }

  private concat(skip: number): Uint8Array {
    const out = new Uint8Array(Math.max(0, this.bytes - skip));
    let remaining = skip;
    let at = 0;
    for (const chunk of this.chunks) {
      if (remaining >= chunk.length) {
        remaining -= chunk.length;
        continue;
      }
      const piece = remaining > 0 ? chunk.slice(remaining) : chunk;
      remaining = 0;
      out.set(piece, at);
      at += piece.length;
    }
    return out;
  }
}

/**
 * Sent before a replay: leave the alt screen, soft-reset, clear. Deliberately
 * not RIS — a hard reset would also throw away the colors and cursor shape the
 * client's own surface was configured with.
 */
export const PTY_REPLAY_RESET = '\u001b[?1049l\u001b[!p\u001b[2J\u001b[H';
