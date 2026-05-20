import type { PromptAnswerBody, PromptAskEvent } from '@agentbox/relay';

/**
 * Steady-state input forwarder + active-prompt capture. The router has zero
 * intercept in steady state (every byte goes to the pty unmodified) — so
 * tmux's `Ctrl+a q`, vim, claude's TUI, etc. all work bit-for-bit as today.
 *
 * Only when `capture()` is awaiting does the router intercept the next
 * keystroke and resolve the prompt with a y/n/cancel answer. Anything else
 * the user types while a prompt is active is dropped (not forwarded) — the
 * inner program doesn't see partial keys.
 */
export interface InputRouter {
  /** True while a prompt is being captured. Used by the run loop to know
   *  whether to redraw the footer eagerly. */
  readonly capturing: boolean;
  /** Feed raw bytes from process.stdin. Forwards or captures internally. */
  feed(buf: Buffer): void;
  /** Activate prompt capture. Resolves with the answer body. Subsequent
   *  capture() calls before resolution overwrite the previous prompt (the
   *  newer one wins — relay broadcast order is canonical). */
  capture(p: PromptAskEvent): Promise<PromptAnswerBody>;
  /** Reject the in-flight capture (pty exit, sibling-wrapper answered). */
  abort(reason: 'pty-exit' | 'resolved-elsewhere'): void;
  dispose(): void;
}

interface ActivePrompt {
  ev: PromptAskEvent;
  resolve: (b: PromptAnswerBody) => void;
  reject: (e: Error) => void;
}

const KEY_ENTER = 0x0d;
const KEY_LF = 0x0a;
const KEY_ESC = 0x1b;
const KEY_CTRL_C = 0x03;
const KEY_Y_LOW = 0x79;
const KEY_Y_UP = 0x59;
const KEY_N_LOW = 0x6e;
const KEY_N_UP = 0x4e;

export interface InputRouterOptions {
  onForward: (b: Buffer) => void;
  /** Called when a prompt's capture is resolved — the run loop POSTs the answer. */
  onAnswer: (body: PromptAnswerBody) => void;
}

export function createInputRouter(opts: InputRouterOptions): InputRouter {
  let active: ActivePrompt | null = null;
  let disposed = false;

  const settle = (
    answer: PromptAnswerBody['answer'],
    cancelled?: boolean,
  ): void => {
    if (!active) return;
    const body: PromptAnswerBody = {
      id: active.ev.id,
      answer,
      ...(cancelled ? { cancelled: true } : {}),
    };
    const p = active;
    active = null;
    p.resolve(body);
    opts.onAnswer(body);
  };

  const handleCapturedByte = (b: number): void => {
    if (!active) return;
    if (b === KEY_Y_LOW || b === KEY_Y_UP) {
      settle('y');
      return;
    }
    if (b === KEY_N_LOW || b === KEY_N_UP) {
      settle('n');
      return;
    }
    if (b === KEY_ESC || b === KEY_CTRL_C) {
      settle('n', true);
      return;
    }
    if (b === KEY_ENTER || b === KEY_LF) {
      // Enter accepts the default answer.
      const def = active.ev.defaultAnswer ?? 'n';
      settle(def);
      return;
    }
    // Anything else: ignored (not forwarded, not consumed).
  };

  return {
    get capturing(): boolean {
      return active !== null;
    },
    feed(buf: Buffer): void {
      if (disposed) return;
      if (active) {
        // A multi-byte read starting with ESC is a CSI/SS3/OSC escape
        // sequence — mouse click (`\x1b[<…M/m`), arrow / function key,
        // window-focus event, bracketed-paste markers, etc. Drop the
        // whole chunk: the user pressed something we don't model as a
        // confirmation key, and they'd be (correctly) surprised if a stray
        // mouse click registered as "deny". A *real* Esc keypress arrives
        // as a single byte in its own read, which still cancels below.
        if (buf.length > 1 && buf[0] === KEY_ESC) return;
        // Process bytes one at a time so a paste of "yes\n" is handled
        // sanely: the 'y' settles, the rest is dropped — we don't want
        // stray bytes leaking to the pty after the prompt closed mid-buf.
        // (After settle, `active` is null; remaining bytes fall through to
        // forward path below.)
        for (let i = 0; i < buf.length; i++) {
          const byte = buf[i];
          if (byte === undefined) continue;
          if (active) {
            handleCapturedByte(byte);
          } else {
            // Active became null mid-buffer (settled). Forward the rest as
            // a normal keystroke chunk.
            opts.onForward(buf.subarray(i));
            return;
          }
        }
        return;
      }
      opts.onForward(buf);
    },
    capture(ev: PromptAskEvent): Promise<PromptAnswerBody> {
      return new Promise<PromptAnswerBody>((resolve, reject) => {
        if (active) {
          // A new prompt arrived before the old one was answered — abort
          // the old one (treated as cancelled) and switch to the new one.
          // The relay already broadcast `prompt-ask` for both; we owe the
          // first an answer or it'll stay pending forever.
          settle('n', true);
        }
        active = { ev, resolve, reject };
      });
    },
    abort(reason): void {
      if (!active) return;
      const p = active;
      active = null;
      const msg = reason === 'pty-exit' ? 'pty exited' : 'resolved by sibling wrapper';
      p.reject(new Error(msg));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (active) {
        const p = active;
        active = null;
        p.reject(new Error('input router disposed'));
      }
    },
  };
}
