import { spawn } from 'node:child_process';
import type { AttachOpenIn } from '@agentbox/config';

export type HostTerminal = 'tmux' | 'iterm2' | 'unknown';

/**
 * Identify the user's host terminal from env vars. tmux wins over iTerm2 even
 * when nested — when `TMUX` is set, the tmux CLI is the right primitive (it can
 * split the current pane / open a new window without going through AppleScript).
 *
 * macOS-only by design: the CLI itself is macOS-only (see CLAUDE.md), so we
 * don't try to recognize gnome-terminal / alacritty / Windows Terminal.
 */
export function detectHostTerminal(env: NodeJS.ProcessEnv = process.env): HostTerminal {
  const tmux = env['TMUX'];
  if (tmux && tmux.length > 0) return 'tmux';
  const termProgram = env['TERM_PROGRAM'];
  if (termProgram === 'iTerm.app') return 'iterm2';
  return 'unknown';
}

/** Single-quote a string so it survives a shell parse intact. */
function shellQuote(s: string): string {
  if (s.length === 0) return "''";
  // Replace any internal `'` with the four-byte sequence `'\''` (close, escaped
  // quote, reopen). Cheaper than picking double-quotes — no $/`/\ to worry about.
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Escape a string for embedding in a double-quoted AppleScript literal. */
function appleScriptEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Join an argv into a single shell-safe command line. */
function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(' ');
}

export interface SpawnInNewTerminalArgs {
  host: Exclude<HostTerminal, 'unknown'>;
  /** Where to open the session in that host's terminology. `'same'` is rejected
   *  by the caller — we never produce `same` here. */
  mode: Exclude<AttachOpenIn, 'same'>;
  /** Full argv to run in the new pane: `[program, ...args]`. The first element
   *  is the binary; the rest are passed verbatim. */
  argv: string[];
  /** Working directory for the new pane. Passed to tmux via `-c` and prepended
   *  to the iTerm2 command as `cd <cwd> && exec …`. */
  cwd: string;
  /** Short title for the new tmux window / iTerm2 tab when applicable. */
  title: string;
}

export interface SpawnInNewTerminalResult {
  launched: boolean;
  /** One-line user-facing message printed to the host's stdout on success.
   *  Empty string when `launched` is false. */
  note: string;
  /** stderr captured from the spawner, when `launched` is false. Used only for
   *  the command log; not surfaced to the user. */
  error?: string;
}

/**
 * Open a fresh tmux pane / iTerm2 split-tab-window and run `<command> <argv...>`
 * there. Returns synchronously after the new pane is requested — the inner
 * command runs in its own terminal and is no longer this process's child.
 *
 * On failure (tmux/osascript exits non-zero, or wasn't found), the caller is
 * expected to fall back to inline attach.
 */
export async function spawnInNewTerminal(
  args: SpawnInNewTerminalArgs,
): Promise<SpawnInNewTerminalResult> {
  if (args.host === 'tmux') return spawnInTmux(args);
  return spawnInITerm2(args);
}

async function spawnInTmux(args: SpawnInNewTerminalArgs): Promise<SpawnInNewTerminalResult> {
  // `-c <cwd>` drops the new pane in the host pane's directory so the
  // recursive `agentbox` invocation can resolve project-scoped refs (and so
  // any commands the user runs after detaching start somewhere sensible).
  // The command is passed as a single shell-quoted positional after `--`;
  // tmux hands it to /bin/sh -c, which is why each argv element needs
  // single-quoting.
  const cmdStr = shellJoin(args.argv);
  let tmuxArgv: string[];
  let noteKind: string;
  if (args.mode === 'split') {
    tmuxArgv = ['split-window', '-h', '-c', args.cwd, '--', cmdStr];
    noteKind = 'tmux split';
  } else {
    // `window` and `tab` both map to tmux's only "another full screen" primitive.
    tmuxArgv = ['new-window', '-n', args.title, '-c', args.cwd, '--', cmdStr];
    noteKind = 'tmux window';
  }
  const r = await runQuiet('tmux', tmuxArgv);
  if (r.code !== 0) {
    return {
      launched: false,
      note: '',
      error: `tmux ${tmuxArgv.join(' ')} exited ${String(r.code)}: ${r.stderr.trim()}`,
    };
  }
  return {
    launched: true,
    note: `Attached in new ${noteKind} — Ctrl+a d to detach the box's tmux session.`,
  };
}

async function spawnInITerm2(args: SpawnInNewTerminalArgs): Promise<SpawnInNewTerminalResult> {
  // iTerm2 launches `command` through a shell, but doesn't honor a starting
  // directory parameter on its AppleScript verbs. Prepend `cd <cwd> && exec`
  // so the new tab/window/split lands in the host pane's cwd and replaces
  // the launching shell with the agentbox process.
  const inner = shellJoin(args.argv);
  const cmdLine = `cd ${shellQuote(args.cwd)} && exec ${inner}`;
  const cmdLit = `"${appleScriptEscape(cmdLine)}"`;

  // Always create the tab/window/split first, then `write text` into its
  // session. The `... with default profile command "<cmd>"` parameter form is
  // unreliable on iTerm 3.7 betas — it fails (returns `missing value`) and the
  // command bounces to Terminal.app instead of running in iTerm. The
  // create-then-write-text form is the supported path and works across
  // versions, so every mode uses it.
  let lines: string[];
  let noteKind: string;
  switch (args.mode) {
    case 'split':
      lines = [
        'tell application "iTerm"',
        '  tell current session of current window to set _s to (split vertically with default profile)',
        `  tell _s to write text ${cmdLit}`,
        'end tell',
      ];
      noteKind = 'iTerm2 split';
      break;
    case 'tab':
      lines = [
        'tell application "iTerm"',
        '  tell current window to set _t to (create tab with default profile)',
        `  tell current session of _t to write text ${cmdLit}`,
        'end tell',
      ];
      noteKind = 'iTerm2 tab';
      break;
    case 'window':
      lines = [
        'tell application "iTerm"',
        '  set _w to (create window with default profile)',
        `  tell current session of _w to write text ${cmdLit}`,
        'end tell',
      ];
      noteKind = 'iTerm2 window';
      break;
  }

  const r = await runQuiet('osascript', ['-e', lines.join('\n')]);
  if (r.code !== 0) {
    return {
      launched: false,
      note: '',
      error: `osascript exited ${String(r.code)}: ${r.stderr.trim()}`,
    };
  }
  return {
    launched: true,
    note: `Attached in new ${noteKind} — Ctrl+a d to detach the box's tmux session.`,
  };
}

interface QuietResult {
  code: number;
  stderr: string;
}

/** Spawn `cmd argv...`, capture stderr, ignore stdout. Resolves on exit. */
function runQuiet(cmd: string, argv: string[]): Promise<QuietResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      resolve({ code: 127, stderr: err.message });
    });
    child.on('exit', (code) => {
      resolve({ code: typeof code === 'number' ? code : 1, stderr });
    });
  });
}
