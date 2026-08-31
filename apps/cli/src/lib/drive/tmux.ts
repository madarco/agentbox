// Thin wrappers around `Provider.exec` that build the in-box tmux argv for the
// `agentbox drive` commands. One place to maintain the tmux invocations so the
// subcommands stay declarative. Everything runs as the `vscode` user inside the
// box — that's the user that owns the tmux server socket under /tmp/tmux-1000/.

import type { BoxRecord, Provider } from '@agentbox/core';

const TMUX_USER = 'vscode';

export interface CaptureOptions {
  /** Re-encode escape sequences in the output (`-e`). */
  ansi?: boolean;
  /** Inclusive line range; passed to tmux as `-S <from> -E <to>` (rows count from 0 at the top of the visible pane; negative numbers walk into the scrollback). */
  rows?: { from: number; to: number };
}

export interface CursorInfo {
  x: number;
  y: number;
}

export interface PaneInfo {
  cols: number;
  rows: number;
  cursor: CursorInfo;
}

/**
 * `tmux capture-pane -p` on the named session/window. Plain by default; with
 * `--ansi` (`-pe`) tmux re-encodes color/style escape sequences so a caller
 * can pipe back through a renderer if needed.
 */
export async function captureSession(
  provider: Provider,
  box: BoxRecord,
  session: string,
  opts: CaptureOptions = {},
): Promise<string> {
  const argv = ['tmux', 'capture-pane', opts.ansi ? '-pe' : '-p', '-t', session];
  if (opts.rows) {
    argv.push('-S', String(opts.rows.from), '-E', String(opts.rows.to));
  }
  const res = await provider.exec(box, argv, { user: TMUX_USER });
  if (res.exitCode !== 0) {
    throw new Error(failure('capture-pane', session, res.stderr || res.stdout));
  }
  // tmux always appends a trailing newline — strip it so callers can `String.includes`
  // without snagging on a phantom empty last line.
  return res.stdout.replace(/\n$/, '');
}

/**
 * Read cols, rows, and cursor position from `tmux display-message -p`. Used by
 * `drive snapshot --with-cursor` to emit a structured JSON envelope.
 */
export async function paneInfo(
  provider: Provider,
  box: BoxRecord,
  session: string,
): Promise<PaneInfo> {
  const fmt = '#{pane_width},#{pane_height},#{cursor_x},#{cursor_y}';
  const res = await provider.exec(box, ['tmux', 'display-message', '-p', '-t', session, fmt], {
    user: TMUX_USER,
  });
  if (res.exitCode !== 0) {
    throw new Error(failure('display-message', session, res.stderr || res.stdout));
  }
  const m = /^(\d+),(\d+),(\d+),(\d+)/.exec(res.stdout.trim());
  if (!m) throw new Error(`tmux display-message returned unexpected output: ${res.stdout}`);
  return {
    cols: Number(m[1]),
    rows: Number(m[2]),
    cursor: { x: Number(m[3]), y: Number(m[4]) },
  };
}

/**
 * `tmux send-keys -l` writes the bytes verbatim — no key-table translation —
 * so control bytes already encoded in the DSL (e.g. 0x01 for Ctrl-a) reach the
 * inner program intact. Pass the resolved DSL string here, not a raw user
 * argv.
 */
export async function sendLiteral(
  provider: Provider,
  box: BoxRecord,
  session: string,
  literal: string,
): Promise<void> {
  if (literal.length === 0) return;
  const res = await provider.exec(box, ['tmux', 'send-keys', '-t', session, '-l', '--', literal], {
    user: TMUX_USER,
  });
  if (res.exitCode !== 0) {
    throw new Error(failure('send-keys -l', session, res.stderr || res.stdout));
  }
}

/**
 * `tmux send-keys` with key-table translation enabled. Use for symbolic keys
 * like `Enter` / `BSpace`; the DSL parser produces literal bytes that go
 * through `sendLiteral`, so this is mostly used by the `prompt` subcommand to
 * append a trailing Enter.
 */
export async function sendKey(
  provider: Provider,
  box: BoxRecord,
  session: string,
  key: string,
): Promise<void> {
  const res = await provider.exec(box, ['tmux', 'send-keys', '-t', session, key], {
    user: TMUX_USER,
  });
  if (res.exitCode !== 0) {
    throw new Error(failure('send-keys', session, res.stderr || res.stdout));
  }
}

/**
 * `tmux resize-window -t <session>:0 -x <cols> -y <rows>`. tmux 3.0+ ships
 * `resize-window`; the box image is already on 3.2.
 */
export async function resizeWindow(
  provider: Provider,
  box: BoxRecord,
  session: string,
  cols: number,
  rows: number,
): Promise<void> {
  const res = await provider.exec(
    box,
    ['tmux', 'resize-window', '-t', session, '-x', String(cols), '-y', String(rows)],
    { user: TMUX_USER },
  );
  if (res.exitCode !== 0) {
    throw new Error(failure('resize-window', session, res.stderr || res.stdout));
  }
}

/**
 * `tmux list-sessions -F "#{session_name}"` — one session name per line.
 * Empty list when no tmux server is running (exit 1 on the box; we swallow it).
 */
export async function listSessions(provider: Provider, box: BoxRecord): Promise<string[]> {
  const res = await provider.exec(box, ['tmux', 'list-sessions', '-F', '#{session_name}'], {
    user: TMUX_USER,
  });
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function failure(op: string, session: string, detail: string): string {
  const tail = detail.trim();
  return `tmux ${op} failed for session '${session}'${tail ? `: ${tail}` : ''}`;
}
