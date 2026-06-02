import { spawn } from 'node:child_process';
import type { AttachOpenIn } from '@agentbox/config';

export type HostTerminal = 'tmux' | 'cmux' | 'iterm2' | 'unknown';

/**
 * Identify the user's host terminal from env vars. tmux wins over everything
 * even when nested — when `TMUX` is set, the tmux CLI is the right primitive (it
 * can split the current pane / open a new window without going through a GUI
 * control channel). cmux is checked next, then iTerm2.
 *
 * tmux is recognized on every host (macOS + Linux) — its CLI is the portable
 * primitive. cmux (https://cmux.com) is a Ghostty-based multiplexer with its own
 * control CLI; it sets `TERM_PROGRAM=ghostty` (shared with standalone Ghostty,
 * which has no spawn CLI), so we key on its `CMUX_*` env vars instead. The
 * iTerm2 path is macOS-only (it drives AppleScript). On Linux we deliberately
 * don't recognize native emulators (gnome-terminal / alacritty / konsole) yet:
 * outside these the caller falls back to attaching in the current terminal. See
 * docs/linux-host-backlog.md.
 */
export function detectHostTerminal(env: NodeJS.ProcessEnv = process.env): HostTerminal {
  const tmux = env['TMUX'];
  // tmux can run inside cmux; if it's active its verbs are the right primitive.
  if (tmux && tmux.length > 0) return 'tmux';
  const cmuxSocket = env['CMUX_SOCKET_PATH'];
  if (cmuxSocket && cmuxSocket.length > 0) return 'cmux';
  const termProgram = env['TERM_PROGRAM'];
  if (termProgram === 'iTerm.app') return 'iterm2';
  return 'unknown';
}

/** Absolute path to the cmux control CLI when running inside cmux, else the
 *  bare `cmux` (which cmux also places on PATH). */
function cmuxBinary(env: NodeJS.ProcessEnv = process.env): string {
  const bundled = env['CMUX_BUNDLED_CLI_PATH'];
  return bundled && bundled.length > 0 ? bundled : 'cmux';
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
  if (args.host === 'cmux') return spawnInCmux(args);
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
    note: `Attached in new ${noteKind}.`,
  };
}

async function spawnInCmux(args: SpawnInNewTerminalArgs): Promise<SpawnInNewTerminalResult> {
  const bin = cmuxBinary();
  const cmdStr = shellJoin(args.argv);

  if (args.mode === 'split') {
    // `new-split` has no --cwd/--command, so we mirror the iTerm2 approach:
    // create the split, then type `cd <cwd> && exec <cmd>` into its surface.
    // `right` matches tmux's `-h` / iTerm2's vertical split (side-by-side).
    const split = await runQuiet(bin, ['new-split', 'right', '--focus', 'true']);
    if (split.code !== 0) {
      return {
        launched: false,
        note: '',
        error: `cmux new-split exited ${String(split.code)}: ${split.stderr.trim()}`,
      };
    }
    // cmux prints the created surface ref (e.g. `surface:2`) on stdout. Target it
    // explicitly so we don't race on which surface is focused.
    const surfaceRef = parseCmuxRef(split.stdout);
    if (!surfaceRef) {
      return {
        launched: false,
        note: '',
        error: `cmux new-split gave no surface ref: ${split.stdout.trim()}`,
      };
    }
    const cmdLine = `cd ${shellQuote(args.cwd)} && exec ${cmdStr}`;
    // `\n` is interpreted by `cmux send` as Enter, which runs the typed command.
    const sent = await runQuiet(bin, ['send', '--surface', surfaceRef, `${cmdLine}\n`]);
    if (sent.code !== 0) {
      return {
        launched: false,
        note: '',
        error: `cmux send exited ${String(sent.code)}: ${sent.stderr.trim()}`,
      };
    }
    return { launched: true, note: 'Attached in new cmux split.' };
  }

  // `window` and `tab` both map to a new cmux workspace (a tab in the current
  // window). `new-workspace` carries cwd + command atomically — no `cd`/`send`
  // dance needed. cmux types `--command` (text + Enter) into the new workspace's
  // shell, which parses the shell-quoting we applied in `cmdStr`.
  const r = await runQuiet(bin, [
    'new-workspace',
    '--name',
    args.title,
    '--cwd',
    args.cwd,
    '--command',
    cmdStr,
    '--focus',
    'true',
  ]);
  if (r.code !== 0) {
    return {
      launched: false,
      note: '',
      error: `cmux new-workspace exited ${String(r.code)}: ${r.stderr.trim()}`,
    };
  }
  return { launched: true, note: 'Attached in new cmux workspace.' };
}

/** Pull the first cmux ref (e.g. `surface:2`) out of CLI stdout. */
function parseCmuxRef(stdout: string): string | undefined {
  const m = stdout.match(/\b(?:surface|pane):\d+\b/);
  return m ? m[0] : undefined;
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
    note: `Attached in new ${noteKind}.`,
  };
}

interface QuietResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn `cmd argv...`, capture stdout + stderr. Resolves on exit. The tmux /
 *  iTerm2 callers ignore stdout; the cmux caller parses it for the surface ref. */
function runQuiet(cmd: string, argv: string[]): Promise<QuietResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      resolve({ code: 127, stdout, stderr: err.message });
    });
    child.on('exit', (code) => {
      resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
    });
  });
}
