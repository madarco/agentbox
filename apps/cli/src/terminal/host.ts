import { spawn } from 'node:child_process';
import type { AttachOpenIn, LoadedConfig } from '@agentbox/config';
import { herdrRequest } from './herdr-socket.js';

export type HostTerminal = 'tmux' | 'cmux' | 'herdr' | 'iterm2' | 'unknown';

/**
 * The effective `attach.openIn`, adjusted for the host terminal. Under Herdr the
 * default is a **tab** rather than a split (a split pane is cramped for an
 * attached agent) — but only when the user hasn't chosen: an explicit
 * `--attach-in` / configured value (any source other than the built-in default)
 * is honored as-is. No effect on other terminals.
 */
export function hostAwareOpenIn(
  cfg: LoadedConfig,
  env: NodeJS.ProcessEnv = process.env,
): AttachOpenIn {
  const openIn = cfg.effective.attach.openIn;
  if (
    openIn === 'split' &&
    cfg.sources['attach.openIn'] === 'default' &&
    detectHostTerminal(env) === 'herdr'
  ) {
    return 'tab';
  }
  return openIn;
}

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
 *
 * Herdr (https://herdr.dev) is a multiplexer that runs *inside* a host terminal,
 * so `TERM_PROGRAM` reflects the outer emulator (e.g. iTerm2). It must therefore
 * be checked *before* iTerm2 — keyed on its `HERDR_SOCKET_PATH` — or attach
 * would spawn iTerm2 windows instead of Herdr panes.
 */
export function detectHostTerminal(env: NodeJS.ProcessEnv = process.env): HostTerminal {
  const tmux = env['TMUX'];
  // tmux can run inside cmux/herdr; if it's active its verbs are the right primitive.
  if (tmux && tmux.length > 0) return 'tmux';
  const cmuxSocket = env['CMUX_SOCKET_PATH'];
  if (cmuxSocket && cmuxSocket.length > 0) return 'cmux';
  const herdrSocket = env['HERDR_SOCKET_PATH'];
  if (herdrSocket && herdrSocket.length > 0) return 'herdr';
  const termProgram = env['TERM_PROGRAM'];
  if (termProgram === 'iTerm.app') return 'iterm2';
  return 'unknown';
}

/** Absolute path to the cmux control CLI when running inside cmux, else the
 *  bare `cmux` (which cmux also places on PATH). */
export function cmuxBinary(env: NodeJS.ProcessEnv = process.env): string {
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
  /**
   * Env for the spawned tmux/cmux helper. Defaults to the current process env.
   * The queue worker passes a captured env (the submitting shell's `TMUX` /
   * `CMUX_SOCKET_PATH`) because its own env points at whatever terminal first
   * started the long-lived relay, not this job's terminal.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * tmux target pane (`$TMUX_PANE`). When set, tmux verbs get `-t <pane>` so a
   * detached spawner (the queue worker, which has no "current" pane) splits /
   * opens from the submitting pane's session.
   */
  tmuxTarget?: string;
  /**
   * cmux surface UUID to split (`split` mode). The queue worker captures the
   * submitting shell's `$CMUX_SURFACE_ID` so it can split the original pane
   * without a focused surface; falls through to `cmuxTargetWorkspace` if the
   * surface is gone by the time the worker fires.
   */
  cmuxTargetSurface?: string;
  /**
   * cmux workspace UUID to target (`$CMUX_WORKSPACE_ID`). Used as the `split`
   * fallback and as the `tab` target so a detached worker lands in the parent
   * workspace instead of a new one.
   */
  cmuxTargetWorkspace?: string;
  /**
   * When the targeted cmux attempts (surface / workspace) all fail or no id was
   * captured, degrade to a new top-level workspace instead of erroring. Set by
   * the queue worker, which has no reliable focused surface to split/tab into.
   */
  cmuxWorkspaceFallback?: boolean;
  /**
   * Herdr pane id to split (`split` mode). The queue worker captures the
   * submitting shell's `$HERDR_PANE_ID`; the foreground path passes its own.
   */
  herdrTargetPane?: string;
  /**
   * Herdr workspace id (`$HERDR_WORKSPACE_ID`). Used as the `tab` target so a
   * new tab lands in the submitting workspace.
   */
  herdrTargetWorkspace?: string;
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
  if (args.host === 'herdr') return spawnInHerdr(args);
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
  // `-t <pane>` is only added when the caller passes an explicit target (the
  // queue worker); the foreground path omits it and tmux uses the current pane.
  const target = args.tmuxTarget ? ['-t', args.tmuxTarget] : [];
  let tmuxArgv: string[];
  let noteKind: string;
  if (args.mode === 'split') {
    tmuxArgv = ['split-window', '-h', ...target, '-c', args.cwd, '--', cmdStr];
    noteKind = 'tmux split';
  } else {
    // `window` and `tab` both map to tmux's only "another full screen" primitive.
    tmuxArgv = ['new-window', ...target, '-n', args.title, '-c', args.cwd, '--', cmdStr];
    noteKind = 'tmux window';
  }
  const r = await runQuiet('tmux', tmuxArgv, args.env);
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

/**
 * cmux concept map (https://cmux.com): a *workspace* is a top-level tab in the
 * workspace bar; a *pane* is a split region inside a workspace; a *surface* is a
 * tab inside a pane. So:
 *   - `split`  → new-split    (a split region in a workspace)
 *   - `tab`    → new-surface  (a tab in a pane — stays in the same workspace)
 *   - `window` → new-workspace (a separate top-level workspace)
 * `split` and `tab` keep the agent in the project's current workspace, which is
 * what you usually want; `window` is the explicit "somewhere separate" choice.
 *
 * The foreground attach path has a focused surface, so `new-split`/`new-surface`
 * land relative to it (no target flags). The queue worker is detached — it has
 * no focus — so it passes the submitting shell's surface/workspace ids and we
 * target them explicitly: for `split` we try `--surface <id>` (the original
 * pane), then `--workspace <id>` (the parent workspace); for `tab` we target
 * `--workspace <id>` (new-surface has no `--surface` flag). When every targeted
 * attempt fails (or no id was captured) and `cmuxWorkspaceFallback` is set, we
 * degrade to a new workspace rather than erroring.
 */
async function spawnInCmux(args: SpawnInNewTerminalArgs): Promise<SpawnInNewTerminalResult> {
  const bin = cmuxBinary(args.env);

  if (args.mode === 'window') return newCmuxWorkspace(bin, args);

  // `split` and `tab` stay in a workspace and have no --cwd/--command, so we
  // mirror the iTerm2 approach: create the surface, then type
  // `cd <cwd> && exec <cmd>` into it. `new-split right` matches tmux's `-h` /
  // iTerm2's vertical split (side-by-side); `new-surface` adds a tab to a pane.
  const base = args.mode === 'split' ? ['new-split', 'right'] : ['new-surface'];
  const noteKind = args.mode === 'split' ? 'cmux split' : 'cmux tab';

  // Prioritized create attempts. Surface first (split only — new-surface has no
  // --surface flag), then the parent workspace, then — foreground only — the
  // focus-relative attempt that matches the pre-targeting behavior exactly.
  const attempts: string[][] = [];
  if (args.mode === 'split' && args.cmuxTargetSurface) {
    attempts.push([...base, '--surface', args.cmuxTargetSurface, '--focus', 'true']);
  }
  if (args.cmuxTargetWorkspace) {
    attempts.push([...base, '--workspace', args.cmuxTargetWorkspace, '--focus', 'true']);
  }
  if (!args.cmuxWorkspaceFallback) {
    attempts.push([...base, '--focus', 'true']);
  }

  const cmdLine = `cd ${shellQuote(args.cwd)} && exec ${shellJoin(args.argv)}`;
  let lastError = '';
  for (const createArgv of attempts) {
    const created = await runQuiet(bin, createArgv, args.env);
    // Only a failed *create* (e.g. a stale `--surface` id) is worth retrying the
    // next target for — it left no pane behind. Once the create succeeds a pane
    // exists, so a later parse/send failure is terminal: retrying would stack an
    // orphan empty split/tab on top of it.
    if (created.code !== 0) {
      lastError = `cmux ${createArgv.join(' ')} exited ${String(created.code)}: ${created.stderr.trim()}`;
      continue;
    }
    // cmux prints the created surface ref (e.g. `surface:2`) on stdout. Target
    // it explicitly so we don't race on which surface is focused.
    const surfaceRef = parseCmuxRef(created.stdout);
    if (!surfaceRef) {
      return {
        launched: false,
        note: '',
        error: `cmux ${createArgv[0]} gave no surface ref: ${created.stdout.trim()}`,
      };
    }
    // `\n` is interpreted by `cmux send` as Enter, which runs the typed command.
    const sent = await runQuiet(bin, ['send', '--surface', surfaceRef, `${cmdLine}\n`], args.env);
    if (sent.code !== 0) {
      return {
        launched: false,
        note: '',
        error: `cmux send exited ${String(sent.code)}: ${sent.stderr.trim()}`,
      };
    }
    return { launched: true, note: `Attached in new ${noteKind}.` };
  }

  // Detached worker: no targeted attempt landed, so open a separate workspace
  // rather than erroring. Foreground callers surface the failure instead.
  if (args.cmuxWorkspaceFallback) return newCmuxWorkspace(bin, args);
  return { launched: false, note: '', error: lastError };
}

/** Open `<command>` in a fresh top-level cmux workspace. `new-workspace` carries
 *  cwd + command atomically (it types `--command` + Enter into the new
 *  workspace's shell, which parses the shell-quoting we applied). */
async function newCmuxWorkspace(
  bin: string,
  args: SpawnInNewTerminalArgs,
): Promise<SpawnInNewTerminalResult> {
  const r = await runQuiet(
    bin,
    [
      'new-workspace',
      '--name',
      args.title,
      '--cwd',
      args.cwd,
      '--command',
      shellJoin(args.argv),
      '--focus',
      'true',
    ],
    args.env,
  );
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

/** Read a string field off a nested object in a Herdr reply, if present. */
function herdrField(
  result: Record<string, unknown> | null,
  parent: string,
  key: string,
): string | undefined {
  const obj = result?.[parent];
  if (obj && typeof obj === 'object') {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Pull the new pane id (e.g. `w1:p2`) out of a Herdr create reply. The pane
 * lives under `pane` for `pane.split` and under `root_pane` for
 * `tab.create`/`workspace.create` (verified live against Herdr 0.7); a regex
 * over the serialized reply is the last-ditch fallback.
 */
function extractHerdrPaneId(result: Record<string, unknown> | null): string | undefined {
  if (!result) return undefined;
  const direct = result['pane_id'];
  if (typeof direct === 'string' && /:p\d+$/.test(direct)) return direct;
  for (const parent of ['pane', 'root_pane'] as const) {
    const id = herdrField(result, parent, 'pane_id');
    if (id && /:p\d+$/.test(id)) return id;
  }
  const m = JSON.stringify(result).match(/"([^"]*:p\d+)"/);
  return m ? m[1] : undefined;
}

/**
 * Open `<command>` in a new Herdr pane via the socket API
 * (https://herdr.dev/docs/socket-api):
 *   - `split`  → `pane.split`       (a split region beside the current pane)
 *   - `tab`    → `tab.create`       (a new tab in the current workspace)
 *   - `window` → `workspace.create` (a separate top-level workspace)
 * Each create returns a new pane id; we then type `cd <cwd> && exec <cmd>` into
 * it (mirroring the cmux / iTerm2 paths) so the new pane lands in the host
 * pane's cwd and replaces its shell with the agentbox process. Herdr has no
 * `pane.focus`, so we focus the new tab/workspace via `tab.focus`/
 * `workspace.focus` (a split stays beside the visible current pane). On any
 * failure (no socket, error reply, no pane id) we return `launched:false` so the
 * caller falls back to inline attach.
 */
async function spawnInHerdr(args: SpawnInNewTerminalArgs): Promise<SpawnInNewTerminalResult> {
  const env = args.env;
  // Creating a pane/tab/workspace is heavier than a query and gets slower when
  // several queue workers fan out tabs at once (the `-i` concurrency case), so
  // give the create a wider window than the default 2s before falling back.
  const CREATE_TIMEOUT_MS = 6000;
  let result: Record<string, unknown> | null;
  let noteKind: string;
  if (args.mode === 'split') {
    const params: Record<string, unknown> = { direction: 'right', ratio: 0.5 };
    if (args.herdrTargetPane) params['pane_id'] = args.herdrTargetPane;
    result = await herdrRequest('pane.split', params, env, CREATE_TIMEOUT_MS);
    noteKind = 'Herdr split';
  } else if (args.mode === 'tab') {
    const params: Record<string, unknown> = {};
    if (args.herdrTargetWorkspace) params['workspace_id'] = args.herdrTargetWorkspace;
    result = await herdrRequest('tab.create', params, env, CREATE_TIMEOUT_MS);
    noteKind = 'Herdr tab';
  } else {
    result = await herdrRequest(
      'workspace.create',
      { cwd: args.cwd, label: args.title },
      env,
      CREATE_TIMEOUT_MS,
    );
    noteKind = 'Herdr workspace';
  }

  const paneId = extractHerdrPaneId(result);
  if (!paneId) {
    return { launched: false, note: '', error: `herdr ${args.mode} gave no pane id` };
  }
  // `\n` runs the typed command. `cd && exec` lands in the host cwd and replaces
  // the new pane's shell with the attach process.
  const text = `cd ${shellQuote(args.cwd)} && exec ${shellJoin(args.argv)}\n`;
  const sent = await herdrRequest('pane.send_text', { pane_id: paneId, text }, env);
  if (sent === null) {
    return { launched: false, note: '', error: 'herdr pane.send_text failed' };
  }
  // Best-effort focus of the new surface (no-op for split — Herdr has no pane focus).
  if (args.mode === 'tab') {
    const tabId = herdrField(result, 'tab', 'tab_id');
    if (tabId) void herdrRequest('tab.focus', { tab_id: tabId }, env);
  } else if (args.mode === 'window') {
    const wsId = herdrField(result, 'workspace', 'workspace_id');
    if (wsId) void herdrRequest('workspace.focus', { workspace_id: wsId }, env);
  }
  return { launched: true, note: `Attached in new ${noteKind}.` };
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
 *  iTerm2 callers ignore stdout; the cmux caller parses it for the surface ref.
 *  `env` defaults to the current process env; the queue worker passes a captured
 *  env so tmux/cmux talk to the submitting shell's server, not the relay's. */
function runQuiet(cmd: string, argv: string[], env?: NodeJS.ProcessEnv): Promise<QuietResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], env });
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
