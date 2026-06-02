export type InputEvent =
  | { type: 'switch'; dir: 'next' | 'prev' }
  | { type: 'quit' }
  | { type: 'action'; name: 'screen' | 'code' | 'url' | 'pause' | 'stop' | 'destroy' }
  | { type: 'leader'; active: boolean }
  | { type: 'forward'; bytes: Buffer };

export interface InputParserOptions {
  onEvent: (e: InputEvent) => void;
  /**
   * Map a 1-based absolute screen coordinate from a host mouse report into the
   * right pane's 1-based local coordinate. Return null to drop the event (the
   * pointer is over the sidebar/status). Omit to forward mouse unchanged.
   */
  mouseTransform?: (x: number, y: number) => { x: number; y: number } | null;
  /** Timeout after a bare leader (Ctrl-a) before it's sent through (ms). */
  leaderMs?: number;
  /** Inter-byte timeout for an unfinished escape/mouse sequence (ms). */
  escMs?: number;
  /** Injected for unit tests; defaults to global timers. */
  setTimer?: (ms: number, fn: () => void) => unknown;
  clearTimer?: (h: unknown) => void;
}

const LEADER = 0x01; // Ctrl-a
const ESC = 0x1b;

type State = 'normal' | 'leader' | 'esc' | 'mouseX10';

/**
 * Byte-level host-stdin parser.
 *
 * - Switch boxes: `Ctrl+Option+Up/Down` (CSI `1;7A`/`1;7B`) — the one chord
 *   macOS/iTerm2 reliably emits.
 * - Everything else (screen/code/url/quit/…) is a `Ctrl-a <key>` leader chord —
 *   `Ctrl+Option+<letter>` is too terminal-dependent to rely on.
 *
 * Unrecognized input is forwarded verbatim to the pty, with timeout buffering
 * so a real ESC or a forwarded escape sequence is never swallowed.
 */
export class InputParser {
  private state: State = 'normal';
  private esc: number[] = [];
  private fwd: number[] = [];
  private timer: unknown = null;
  private timerId = 0;
  private readonly leaderMs: number;
  private readonly escMs: number;
  private readonly setTimer: (ms: number, fn: () => void) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly onEvent: (e: InputEvent) => void;
  private readonly mouseTransform?: (x: number, y: number) => { x: number; y: number } | null;

  constructor(opts: InputParserOptions) {
    this.onEvent = opts.onEvent;
    this.mouseTransform = opts.mouseTransform;
    this.leaderMs = opts.leaderMs ?? 700;
    this.escMs = opts.escMs ?? 50;
    this.setTimer = opts.setTimer ?? ((ms, fn) => setTimeout(fn, ms) as unknown);
    this.clearTimer =
      opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  feed(buf: Buffer): void {
    let i = 0;
    while (i < buf.length) {
      const b = buf[i]!;
      if (this.state === 'normal') {
        if (b === LEADER) {
          this.flush();
          this.state = 'leader';
          this.onEvent({ type: 'leader', active: true });
          this.arm(this.leaderMs, 'leader');
        } else if (b === ESC) {
          this.flush();
          this.state = 'esc';
          this.esc = [ESC];
          this.arm(this.escMs, 'esc');
        } else {
          this.fwd.push(b);
        }
        i++;
        continue;
      }
      if (this.state === 'leader') {
        this.disarm();
        if (b === LEADER) {
          this.fwd.push(LEADER); // double Ctrl-a → one literal Ctrl-a
          this.flush();
        } else {
          const c = String.fromCharCode(b);
          if (c === 's') this.onEvent({ type: 'action', name: 'screen' });
          else if (c === 'u') this.onEvent({ type: 'action', name: 'url' });
          else if (c === 'c') this.onEvent({ type: 'action', name: 'code' });
          else if (c === 't') this.onEvent({ type: 'action', name: 'stop' });
          else if (c === 'p') this.onEvent({ type: 'action', name: 'pause' });
          // `k` (kill) destroys; matches the attach footer's Ctrl+a k and keeps
          // `d` reserved for detach there, so the same chord never means two
          // different things across the two UIs. Box switching is Control+Option+↑/↓.
          else if (c === 'k') this.onEvent({ type: 'action', name: 'destroy' });
          else if (c === 'q') this.onEvent({ type: 'quit' });
          else if (c === 'j' || c === 'n' || c === 'N') this.onEvent({ type: 'switch', dir: 'next' });
          else {
            // Unrecognized chord: leader consumed, forward this byte only.
            this.fwd.push(b);
            this.flush();
          }
        }
        this.onEvent({ type: 'leader', active: false });
        this.state = 'normal';
        i++;
        continue;
      }
      if (this.state === 'mouseX10') {
        this.esc.push(b);
        if (this.esc.length === 6) {
          this.disarm();
          this.emitMouseX10();
          this.reset();
        } else {
          this.arm(this.escMs, 'esc');
        }
        i++;
        continue;
      }
      // state === 'esc'
      if (this.esc.length === 1) {
        if (b === 0x5b /* [ */ || b === 0x4f /* O */) {
          this.esc.push(b);
          this.arm(this.escMs, 'esc');
          i++;
          continue;
        }
        this.disarm();
        this.forwardVerbatim([ESC]);
        this.reset();
        continue; // reprocess b in 'normal'
      }
      if (this.esc[1] === 0x5b && this.esc.length === 2 && b === 0x4d /* M */) {
        this.esc.push(b); // legacy X10 mouse: ESC [ M + 3 raw bytes
        this.state = 'mouseX10';
        this.arm(this.escMs, 'esc');
        i++;
        continue;
      }
      this.esc.push(b);
      const isFinal = this.esc[1] === 0x4f ? this.esc.length === 3 : b >= 0x40 && b <= 0x7e;
      const isParam = b >= 0x20 && b <= 0x3f;
      if (isFinal) {
        this.disarm();
        this.classifyCsi();
        this.reset();
      } else if (isParam || this.esc[1] === 0x4f) {
        this.arm(this.escMs, 'esc');
      } else {
        this.disarm();
        this.forwardVerbatim(this.esc);
        this.reset();
      }
      i++;
    }
    if (this.state === 'normal') this.flush();
  }

  dispose(): void {
    this.disarm();
  }

  private classifyCsi(): void {
    const s = String.fromCharCode(...this.esc);
    if (s === '\x1b[1;7A') return void this.onEvent({ type: 'switch', dir: 'prev' });
    if (s === '\x1b[1;7B') return void this.onEvent({ type: 'switch', dir: 'next' });
    const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(s);
    if (m) return this.emitMouseSgr(m);
    this.forwardVerbatim(this.esc);
  }

  private emitMouseSgr(m: RegExpExecArray): void {
    if (!this.mouseTransform) {
      this.forwardVerbatim(this.esc);
      return;
    }
    const t = this.mouseTransform(Number(m[2]), Number(m[3]));
    if (!t) return; // over sidebar/status — drop
    this.forwardVerbatim([
      ...Buffer.from(`\x1b[<${m[1]!};${String(t.x)};${String(t.y)}${m[4]!}`, 'latin1'),
    ]);
  }

  private emitMouseX10(): void {
    const e = this.esc; // ESC [ M cb cx cy
    if (e.length !== 6 || !this.mouseTransform) {
      this.forwardVerbatim(e);
      return;
    }
    const t = this.mouseTransform(e[4]! - 32, e[5]! - 32);
    if (!t) return;
    this.forwardVerbatim([0x1b, 0x5b, 0x4d, e[3]!, t.x + 32, t.y + 32]);
  }

  private reset(): void {
    this.state = 'normal';
    this.esc = [];
  }

  private flush(): void {
    if (this.fwd.length === 0) return;
    this.onEvent({ type: 'forward', bytes: Buffer.from(this.fwd) });
    this.fwd = [];
  }

  private forwardVerbatim(bytes: number[]): void {
    for (const x of bytes) this.fwd.push(x);
    this.flush();
  }

  private arm(ms: number, kind: 'leader' | 'esc'): void {
    this.disarm();
    const id = ++this.timerId;
    this.timer = this.setTimer(ms, () => {
      if (id !== this.timerId) return; // stale
      this.timer = null;
      if (kind === 'leader' && this.state === 'leader') {
        this.fwd.push(LEADER); // lone Ctrl-a → send it through
        this.flush();
        this.onEvent({ type: 'leader', active: false });
        this.state = 'normal';
      } else if (kind === 'esc' && (this.state === 'esc' || this.state === 'mouseX10')) {
        this.forwardVerbatim(this.esc);
        this.reset();
      }
    });
  }

  private disarm(): void {
    this.timerId++;
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
