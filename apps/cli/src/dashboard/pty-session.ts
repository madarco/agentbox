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
 * One box's live terminal: a node-pty running `docker exec … tmux attach`
 * feeding an @xterm/headless emulator we read back as a screen grid.
 */
export class PtySession {
  private readonly term: XtermTerminal;
  private readonly pty: IPtyLike;
  private disposed = false;
  // Reused per cell read — valid only until the next cell() call (the renderer
  // consumes it synchronously within composeRow).
  private readonly out: CellLike = { ...BLANK };

  constructor(
    spawn: PtySpawn,
    TerminalClass: TerminalCtor,
    dockerArgv: string[],
    cols: number,
    rows: number,
    onRenderable: () => void,
    onExit: () => void,
  ) {
    this.term = new TerminalClass({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 0,
      convertEol: false,
    });
    this.pty = spawn('docker', dockerArgv, {
      name: 'xterm-256color',
      cols,
      rows,
      env: process.env,
    });
    this.pty.onData((d) => {
      // Read the buffer only after the parser applied this chunk.
      this.term.write(d, () => onRenderable());
    });
    this.term.onData((d) => {
      if (!this.disposed) this.pty.write(d);
    });
    // Only surface *unexpected* exits. When we kill the pty ourselves (box
    // switch / teardown) `disposed` is already true; a stale exit from a
    // just-killed session must not tear down the session that replaced it.
    this.pty.onExit(() => {
      if (!this.disposed) onExit();
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
  }
}
