import type { PromptAnswerBody, PromptAskEvent } from '@agentbox/relay';

/**
 * Steady-state input forwarder + active-prompt capture + Ctrl+a leader.
 *
 * In steady state every byte goes to the pty unmodified — *unless* a
 * `leaderChords` map is supplied, in which case `Ctrl+a` (0x01) opens the
 * actions menu (leader-only: a literal Ctrl+a needs a double-press).
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

/** Actions reachable from the Ctrl+a leader menu. */
export type LeaderAction = 'screen' | 'code' | 'url' | 'detach';

const KEY_ENTER = 0x0d;
const KEY_LF = 0x0a;
const KEY_ESC = 0x1b;
const KEY_CTRL_C = 0x03;
const KEY_Y_LOW = 0x79;
const KEY_Y_UP = 0x59;
const KEY_N_LOW = 0x6e;
const KEY_N_UP = 0x4e;
const KEY_LEADER = 0x01; // Ctrl-a
const KEY_CTRL_V = 0x16; // Ctrl-v — Claude Code's "paste image from clipboard"
const KEY_A_LOW = 0x61; // 'a'

/**
 * A key decoded from an enhanced-keyboard escape sequence. TUIs like Claude Code
 * can switch the terminal into the kitty keyboard protocol or xterm
 * modifyOtherKeys, in which `Ctrl+a` and even plain letters arrive not as raw
 * bytes but as escape sequences. The leader must decode those so the Actions
 * footer keeps working under those modes.
 */
interface CsiKey {
  /** Total byte length of the sequence (so the caller can advance past it). */
  len: number;
  /** Base unicode codepoint of the key (e.g. 97 for 'a'). */
  code: number;
  /** Whether Ctrl was held. */
  ctrl: boolean;
}

/**
 * Parse a kitty keyboard (`ESC [ <code> ; <mods> u`) or xterm modifyOtherKeys
 * (`ESC [ 27 ; <mods> ; <code> ~`) key sequence at `buf[i]`. Returns the base
 * keycode + Ctrl flag, or null when `buf[i]` isn't one of those (a plain byte,
 * an arrow/function/mouse sequence, or an incomplete sequence split across
 * reads — all of which just forward unchanged). Precise on purpose: only the
 * exact `…u` / `CSI 27 … ~` key shapes match, so cursor/mouse CSI sequences
 * (`ESC [ A`, `ESC [ < … M`) fall through.
 */
function parseCsiKey(buf: Buffer, i: number): CsiKey | null {
  if (buf[i] !== KEY_ESC || buf[i + 1] !== 0x5b /* [ */) return null;
  const params: number[] = [];
  let val = -1;
  for (let j = i + 2; j < buf.length; j++) {
    const b = buf[j];
    if (b !== undefined && b >= 0x30 && b <= 0x39) {
      val = (val < 0 ? 0 : val) * 10 + (b - 0x30);
      continue;
    }
    if (b === 0x3b /* ; */) {
      params.push(val);
      val = -1;
      continue;
    }
    if (b === 0x3a /* : */) {
      // Sub-parameters (kitty event types / alternate keys): record the param,
      // then skip to the next ';' or final byte.
      params.push(val);
      val = -1;
      while (
        j + 1 < buf.length &&
        buf[j + 1] !== 0x3b &&
        buf[j + 1] !== 0x75 &&
        buf[j + 1] !== 0x7e
      ) {
        j++;
      }
      continue;
    }
    if (b === 0x75 /* u */ || b === 0x7e /* ~ */) {
      if (val >= 0) params.push(val);
      const len = j - i + 1;
      const modsToCtrl = (m: number): boolean => ((m - 1) & 4) !== 0;
      if (b === 0x75) {
        // kitty: CSI <code> ; <mods> u
        const code = params[0];
        if (code === undefined || code < 0) return null;
        return { len, code, ctrl: modsToCtrl(params[1] ?? 1) };
      }
      // modifyOtherKeys: CSI 27 ; <mods> ; <code> ~ (other '~' seqs aren't keys)
      if (params[0] !== 27) return null;
      const code = params[2];
      if (code === undefined || code < 0) return null;
      return { len, code, ctrl: modsToCtrl(params[1] ?? 1) };
    }
    return null; // any other byte → not a CSI-u / modifyOtherKeys key
  }
  return null; // incomplete (split across reads) — forward as-is
}

const DEFAULT_LEADER_TIMEOUT_MS = 2000;

export interface InputRouterOptions {
  onForward: (b: Buffer) => void;
  /** Called when a prompt's capture is resolved — the run loop POSTs the answer. */
  onAnswer: (body: PromptAnswerBody) => void;
  /** Ctrl+a leader chord map: a single lowercase character → action. When
   *  omitted or empty the leader is disabled and `Ctrl+a` forwards verbatim. */
  leaderChords?: Readonly<Record<string, LeaderAction>>;
  /** Fired when the leader menu opens (true) / closes (false). */
  onLeaderChange?: (active: boolean) => void;
  /** Fired when a recognized chord key resolves the leader. */
  onAction?: (name: LeaderAction) => void;
  /**
   * When set, a lone `Ctrl+V` (0x16) in steady state is intercepted instead of
   * forwarded: the router awaits this hook (which loads the host clipboard
   * image into the box), then re-emits the `Ctrl+V` so the inner program's own
   * paste handler reads the now-populated box clipboard. Presses while one is
   * in flight are dropped (debounced). When omitted, `Ctrl+V` forwards
   * verbatim. Used for claude image paste; other modes don't pass it. */
  onPasteImage?: () => Promise<unknown>;
  /** ms the leader menu stays open with no key before auto-closing (default 2000). */
  leaderTimeoutMs?: number;
  /** Injected for unit tests; defaults to global timers. */
  setTimer?: (ms: number, fn: () => void) => unknown;
  clearTimer?: (h: unknown) => void;
}

export function createInputRouter(opts: InputRouterOptions): InputRouter {
  let active: ActivePrompt | null = null;
  let disposed = false;

  const leaderChords = opts.leaderChords ?? {};
  const leaderEnabled = Object.keys(leaderChords).length > 0;
  const onPasteImage = opts.onPasteImage;
  const pasteEnabled = typeof onPasteImage === 'function';
  let pasteInFlight = false;
  const leaderTimeoutMs = opts.leaderTimeoutMs ?? DEFAULT_LEADER_TIMEOUT_MS;
  const setTimer = opts.setTimer ?? ((ms, fn) => setTimeout(fn, ms) as unknown);
  const clearTimer =
    opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let leader = false;
  let leaderTimer: unknown = null;

  const disarmLeader = (): void => {
    if (leaderTimer != null) {
      clearTimer(leaderTimer);
      leaderTimer = null;
    }
  };

  const exitLeader = (): void => {
    if (!leader) return;
    leader = false;
    disarmLeader();
    opts.onLeaderChange?.(false);
  };

  const enterLeader = (): void => {
    leader = true;
    disarmLeader();
    // Leader-only: a lone Ctrl+a just times the menu out — it is never
    // auto-forwarded. A literal Ctrl+a is sent via a double-press.
    leaderTimer = setTimer(leaderTimeoutMs, () => {
      leaderTimer = null;
      exitLeader();
    });
    opts.onLeaderChange?.(true);
  };

  // The leader is open and `b` is the chord byte that resolves it.
  const resolveLeaderByte = (b: number): void => {
    if (b === KEY_LEADER) {
      // Double Ctrl+a → one literal Ctrl+a to the inner program.
      exitLeader();
      opts.onForward(Buffer.from([KEY_LEADER]));
      return;
    }
    if (b === KEY_ESC) {
      // Esc dismisses the menu; nothing forwarded.
      exitLeader();
      return;
    }
    const action = leaderChords[String.fromCharCode(b).toLowerCase()];
    if (action) {
      exitLeader();
      opts.onAction?.(action);
      return;
    }
    // Unrecognized chord: close the menu, forward the key so typing isn't lost.
    exitLeader();
    opts.onForward(Buffer.from([b]));
  };

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

  // Intercepted Ctrl+V: run the host→box image-paste hook, then re-emit the
  // Ctrl+V so the inner program reads the (now-loaded) box clipboard. A press
  // while one is in flight is dropped — the Ctrl+V was already swallowed by the
  // caller, so there's nothing to forward.
  const triggerPaste = (): void => {
    if (pasteInFlight) return;
    pasteInFlight = true;
    const done = (): void => {
      pasteInFlight = false;
      if (!disposed) opts.onForward(Buffer.from([KEY_CTRL_V]));
    };
    void Promise.resolve()
      .then(() => onPasteImage?.())
      .then(done, done);
  };

  // Leader-aware steady-state forwarding: scan bytes, batching plain runs into
  // a single onForward call, and intercept `Ctrl+a` chords + `Ctrl+V` paste.
  const feedSteady = (buf: Buffer): void => {
    let chunkStart = 0;
    const flushChunk = (end: number): void => {
      if (end > chunkStart) opts.onForward(buf.subarray(chunkStart, end));
      chunkStart = end;
    };
    let i = 0;
    while (i < buf.length) {
      const byte = buf[i];
      if (byte === undefined) {
        i++;
        continue;
      }

      if (leader) {
        // Resolve the chord. The key may be a raw byte, or — when the inner app
        // enabled an enhanced keyboard protocol — a CSI-u / modifyOtherKeys
        // sequence (e.g. 'c' as `ESC [ 99 u`).
        const k = parseCsiKey(buf, i);
        if (k) {
          if (k.ctrl && k.code === KEY_A_LOW) {
            // Double Ctrl+a → one literal Ctrl+a to the inner program.
            exitLeader();
            opts.onForward(Buffer.from([KEY_LEADER]));
          } else {
            const action = leaderChords[String.fromCharCode(k.code).toLowerCase()];
            exitLeader();
            if (action) opts.onAction?.(action);
            else opts.onForward(buf.subarray(i, i + k.len)); // unknown: don't lose it
          }
          i += k.len;
          chunkStart = i;
          continue;
        }
        resolveLeaderByte(byte);
        i += 1;
        chunkStart = i;
        continue;
      }

      if (leaderEnabled && byte === KEY_LEADER) {
        flushChunk(i); // forward everything typed before the Ctrl+a
        enterLeader();
        i += 1;
        chunkStart = i;
        continue;
      }
      // Ctrl+a re-encoded by an enhanced keyboard protocol (kitty / modifyOtherKeys).
      if (leaderEnabled && byte === KEY_ESC) {
        const k = parseCsiKey(buf, i);
        if (k && k.ctrl && k.code === KEY_A_LOW) {
          flushChunk(i);
          enterLeader();
          i += k.len;
          chunkStart = i;
          continue;
        }
      }
      if (pasteEnabled && byte === KEY_CTRL_V) {
        flushChunk(i); // forward everything typed before the Ctrl+V
        i += 1;
        chunkStart = i; // swallow it; triggerPaste re-emits after the load
        triggerPaste();
        continue;
      }
      i += 1;
    }
    flushChunk(buf.length);
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
      if (!leaderEnabled && !pasteEnabled) {
        opts.onForward(buf);
        return;
      }
      feedSteady(buf);
    },
    capture(ev: PromptAskEvent): Promise<PromptAnswerBody> {
      return new Promise<PromptAnswerBody>((resolve, reject) => {
        // A relay prompt outranks the actions menu — close the leader first.
        if (leader) exitLeader();
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
      disarmLeader();
      if (active) {
        const p = active;
        active = null;
        p.reject(new Error('input router disposed'));
      }
    },
  };
}
