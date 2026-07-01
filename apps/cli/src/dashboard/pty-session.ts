import type { Terminal as XtermTerminal } from '@xterm/headless';
import type { ScreenSnapshot, CellLike, ColorSpec } from './renderer.js';
import type { IPtyLike, PtySpawn, TerminalCtor } from '../pty/pty-backend.js';

// Re-export types so dashboard-internal imports don't have to know about the
// shared module split. New code should import directly from ../pty/pty-backend.
export type { IPtyLike, PtySpawn, TerminalCtor };

function fgSpec(c: {
  isFgDefault(): boolean;
  isFgPalette(): boolean;
  isFgRGB(): boolean;
  getFgColor(): number;
}): ColorSpec {
  if (c.isFgDefault()) return { kind: 'default' };
  if (c.isFgPalette()) return { kind: 'palette', n: c.getFgColor() };
  if (c.isFgRGB()) return { kind: 'rgb', rgb: c.getFgColor() };
  return { kind: 'default' };
}
function bgSpec(c: {
  isBgDefault(): boolean;
  isBgPalette(): boolean;
  isBgRGB(): boolean;
  getBgColor(): number;
}): ColorSpec {
  if (c.isBgDefault()) return { kind: 'default' };
  if (c.isBgPalette()) return { kind: 'palette', n: c.getBgColor() };
  if (c.isBgRGB()) return { kind: 'rgb', rgb: c.getBgColor() };
  return { kind: 'default' };
}

/**
 * Host mouse reporting is owned by the compositor, not mirrored from the inner
 * app. We enable button + SGR-coordinate reporting once for the whole dashboard
 * (the right pane is always a terminal that wants the wheel) and clear the
 * whole family on teardown — mirroring the inner app's rapid on/off toggles
 * leaves frequent windows where the host falls back to native scroll.
 */
// 1000 = click/wheel, 1002 = button-event tracking, 1006 = SGR coords. This is
// the exact set real tmux emits — the combination iTerm2 honors reliably (1000
// alone is enough for xterm/VS Code but iTerm2 wants 1002 present too).
export const MOUSE_ENABLE_SEQ = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const MOUSE_MODES = [1000, 1002, 1003, 1005, 1006, 1015];
export const MOUSE_DISABLE_SEQ = MOUSE_MODES.map((n) => `\x1b[?${String(n)}l`).join('');

// modifyOtherKeys=1 — ask the outer terminal to disambiguate modifier+key combos
// that have no legacy encoding (notably Shift+Enter / Ctrl+Enter, which would
// otherwise collapse to plain `\r`). Mode 1 (not 2) is deliberate: mode 2 also
// rewrites Ctrl+letter as CSI sequences, which would break the dashboard's
// `Ctrl-a` leader chord (see LEADER = 0x01 in input.ts). Mode 1 preserves the
// legacy Ctrl+letter bytes and only escapes keys that would otherwise be
// ambiguous, so Shift+Enter arrives as `\x1b[27;2;13~` (or `\x1b[13;2u`
// depending on the terminal) and Ctrl+a still arrives as `\x01`.
//
// Why the dashboard has to emit this at all: the in-box tmux already runs with
// `extended-keys on` (see buildTmuxSessionArgs in
// packages/sandbox-docker/src/claude.ts), which decodes either CSI form when
// tmux receives it. In the wrapped-pty attach path tmux's own output reaches
// the host terminal, which is enough to coax most terminals into emitting the
// extended encodings. In the dashboard the inner PTY's output flows only into
// @xterm/headless (this file, constructor below) and the compositor renders a
// cell grid from the parsed state — so any mode-set request from tmux is
// consumed by the headless parser and never reaches the user's real terminal.
// The compositor emits it itself on start (and the reset on teardown).
export const EXT_KEYS_ENABLE_SEQ = '\x1b[>4;1m';
export const EXT_KEYS_DISABLE_SEQ = '\x1b[>4m';

const BLANK: CellLike = {
  width: 1,
  chars: ' ',
  fg: { kind: 'default' },
  bg: { kind: 'default' },
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  invisible: false,
  strike: false,
};

/**
 * One box's live terminal: a node-pty running either `docker exec … tmux
 * attach` (docker provider) or `ssh … tmux …` (cloud providers via
 * `Provider.buildAttach`) and feeding an @xterm/headless emulator we read
 * back as a screen grid. The optional `cleanup` callback fires from
 * `dispose()` — daytona's `buildAttach` returns a `revokeAttachToken`
 * cleanup so its 60-min ephemeral SSH token doesn't outlive the attach.
 */
export class PtySession {
  /** Box this session attaches to. Identifies it in the compositor's pool. */
  readonly boxId: string;
  /** When true, the compositor keeps this session alive (in its pool) across
   *  box switches instead of disposing it — see {@link Compositor.liveSessions}. */
  readonly keepAlive: boolean;
  /** Agent/shell mode of this attach. The compositor restores `activeMode`
   *  (drives the footer) from this when re-showing a pooled session. */
  readonly mode: 'claude' | 'shell' | 'codex' | 'opencode';
  /**
   * Whether this session is the one currently shown in the right pane. A
   * kept-alive hidden session (`active === false`) still consumes PTY output
   * to keep its headless buffer current, but must NOT trigger right-pane
   * repaints. The compositor flips this on show/hide.
   */
  active = true;
  private readonly term: XtermTerminal;
  private readonly pty: IPtyLike;
  private readonly cleanup?: () => Promise<void>;
  private disposed = false;
  // Reused per cell read — valid only until the next cell() call (the renderer
  // consumes it synchronously within composeRow).
  private readonly out: CellLike = { ...BLANK };

  constructor(
    spawn: PtySpawn,
    TerminalClass: TerminalCtor,
    boxId: string,
    keepAlive: boolean,
    mode: 'claude' | 'shell' | 'codex' | 'opencode',
    command: string,
    args: string[],
    cols: number,
    rows: number,
    onRenderable: () => void,
    onExit: (boxId: string) => void,
    cleanup?: () => Promise<void>,
    env?: NodeJS.ProcessEnv,
  ) {
    this.boxId = boxId;
    this.keepAlive = keepAlive;
    this.mode = mode;
    this.term = new TerminalClass({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 0,
      convertEol: false,
    });
    this.cleanup = cleanup;
    this.pty = spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      // Merge provider-supplied env over the host env. e2b's attach helper
      // reads the inner tmux command + API key from here (passed via env, not
      // argv); without the merge the helper exits before attaching.
      env: env ? { ...process.env, ...env } : process.env,
    });
    this.pty.onData((d) => {
      // Always feed the parser so the headless buffer stays current even while
      // hidden; only schedule a paint when this session is the shown one.
      this.term.write(d, () => {
        if (this.active) onRenderable();
      });
    });
    this.term.onData((d) => {
      if (!this.disposed) this.pty.write(d);
    });
    // Only surface *unexpected* exits. When we kill the pty ourselves (box
    // switch / teardown) `disposed` is already true; a stale exit from a
    // just-killed session must not tear down the session that replaced it.
    // The boxId lets the compositor evict the right pool entry without
    // assuming the dead session is the active one (a hidden box can die).
    this.pty.onExit(() => {
      if (!this.disposed) onExit(this.boxId);
    });
  }

  write(bytes: Buffer): void {
    if (!this.disposed) this.pty.write(bytes.toString('utf8'));
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.term.resize(cols, rows);
    this.pty.resize(cols, rows);
  }

  snapshot(): ScreenSnapshot {
    const buf = this.term.buffer.active;
    const base = buf.baseY;
    const cell = buf.getNullCell();
    const o = this.out;
    return {
      cols: this.term.cols,
      rows: this.term.rows,
      cursor: { x: buf.cursorX, y: buf.cursorY, visible: true },
      cell: (x: number, y: number): CellLike => {
        const line = buf.getLine(base + y);
        if (!line) return BLANK;
        line.getCell(x, cell);
        o.width = cell.getWidth();
        o.chars = cell.getChars();
        o.fg = fgSpec(cell);
        o.bg = bgSpec(cell);
        o.bold = Boolean(cell.isBold());
        o.dim = Boolean(cell.isDim());
        o.italic = Boolean(cell.isItalic());
        o.underline = Boolean(cell.isUnderline());
        o.inverse = Boolean(cell.isInverse());
        o.invisible = Boolean(cell.isInvisible());
        o.strike = Boolean(cell.isStrikethrough());
        return o;
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.pty.kill();
    } catch {
      /* already gone */
    }
    this.term.dispose();
    if (this.cleanup) void this.cleanup().catch(() => {});
  }
}
