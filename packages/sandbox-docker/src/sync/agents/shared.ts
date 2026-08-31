/**
 * Box plumbing every agent shares — the tmux session shape, the TERM guard, and
 * the container user.
 *
 * These lived in `claude.ts` and were imported from there by `codex.ts`,
 * `opencode.ts`, `seed.ts` and `shell-session.ts`, which made Claude the de
 * facto shared module: nothing here is Claude-specific, and `buildShellArgv`
 * backs `agentbox shell`, which has no agent at all. That was harmless while the
 * three agents were siblings in one package; it stops being harmless the moment
 * each agent becomes its own package, because every one of them would then
 * depend on `@agentbox/agent-claude` for a tmux flag.
 */

/** The unprivileged user a box's work runs as. */
export const CONTAINER_USER = 'vscode';

/**
 * Shell snippet (run via `sh -c`) that guarantees TERM resolves inside the box
 * before tmux starts. The box runs Ubuntu, whose terminfo database does not
 * carry every host terminal: notably `xterm-ghostty`, which was added to
 * ncurses after 24.04 shipped. Forwarding such a TERM makes `tmux attach` exit
 * immediately with "missing or unsuitable terminal", which looks like a brief
 * flash and an instant exit. When the box cannot resolve $TERM, fall back to
 * xterm-256color, which the image always provides.
 */
export const TERM_FALLBACK_SNIPPET =
  'if ! infocmp "$TERM" >/dev/null 2>&1; then TERM=xterm-256color; export TERM; fi; ';

/**
 * Build the `docker exec` argv that runs an in-box tmux command under `sh -c`
 * with the TERM guard ({@link TERM_FALLBACK_SNIPPET}) applied first.
 *
 * `tmuxScript` is the tmux command line as it should reach tmux (use `\;` for
 * tmux's own command separator, since a shell now parses it). `positionals` are
 * bound to "$1", "$2", ... inside the script, so session names are passed as
 * args rather than interpolated, keeping names with odd characters safe. The
 * host's TERM is still forwarded via `-e`, so a box that does know it keeps full
 * fidelity; the guard only downgrades the unknown case.
 */
export function buildTermSafeTmuxExec(opts: {
  container: string;
  user: string;
  tmuxScript: string;
  positionals: string[];
}): string[] {
  const term = process.env['TERM'] ?? 'xterm-256color';
  return [
    'exec',
    '-it',
    '-e',
    `TERM=${term}`,
    '--user',
    opts.user,
    opts.container,
    'sh',
    '-c',
    `${TERM_FALLBACK_SNIPPET}${opts.tmuxScript}`,
    'sh',
    ...opts.positionals,
  ];
}

/**
 * The list of tmux subcommands that configure a session: remap the prefix
 * (Ctrl+a primary, Ctrl+b kept as secondary), enable CSI-u extended-key
 * reporting so Claude Code can distinguish Shift+Enter from Enter, and turn
 * the inner tmux status bar off so it doesn't double up with the outer
 * wrapped-pty footer. Single source of truth shared by the docker path
 * (via {@link buildTmuxSessionArgs}, which folds these into execa argv with
 * `;` separators) and the cloud path (via
 * {@link buildTmuxConfigShellSnippet}, which formats them as `tmux …`
 * shell statements for SSH transport).
 *
 * `prefix`/`bind-key` are server-global (no `-t`) — fine because each box
 * runs one tmux server per session role. `status off` is session-scoped
 * with `-t <session>` so the dashboard's grouped sibling session
 * (`<name>-dash`) keeps its own option scope.
 */
function tmuxConfigSubcommands(sessionName: string): readonly (readonly string[])[] {
  return [
    ['set', '-g', 'prefix', 'C-a'],
    ['set', '-g', 'prefix2', 'C-b'],
    ['bind-key', 'C-a', 'send-prefix'],
    ['bind-key', 'C-b', 'send-prefix', '-2'],
    ['bind-key', 'd', 'detach-client'],
    ['set', '-g', 'extended-keys', 'on'],
    ['set', '-as', 'terminal-features', ',*:extkeys'],
    ['set', '-t', sessionName, 'status', 'off'],
  ];
}

/**
 * tmux command-list (separator-prefixed) appended after `tmux new-session …`
 * in {@link startClaudeSession}. The bare `;` elements are tmux's command
 * separator (execa array args, no host shell, so they reach tmux verbatim).
 * See {@link tmuxConfigSubcommands} for the shared subcommand definitions
 * and why each setting is set the way it is.
 */
export function buildTmuxSessionArgs(sessionName: string): string[] {
  const out: string[] = [];
  for (const sub of tmuxConfigSubcommands(sessionName)) {
    out.push(';', ...sub);
  }
  return out;
}

/**
 * Same tmux configuration as {@link buildTmuxSessionArgs}, formatted as a
 * shell snippet (`tmux <args>; tmux <args>; …`) suitable for transports
 * that go through a remote shell — i.e. the cloud providers' `ssh -t`
 * attach in `@agentbox/sandbox-cloud`'s `renderInnerCommand`. The docker
 * path uses execa argv directly and doesn't need this.
 *
 * Each subcommand is its own `tmux` invocation joined with `; ` (shell
 * statement separator), because the in-tmux `;` separator can't pass
 * through `ssh -t '...'` without ambiguity — single-quoted shell args
 * forward `;` to the remote shell, where it would split the command line
 * before reaching tmux. Multiple `tmux` invocations are equivalent
 * (they're all idempotent `set`/`bind-key` operations) and re-applying
 * on every reattach is harmless.
 */
export function buildTmuxConfigShellSnippet(sessionName: string): string {
  return tmuxConfigSubcommands(sessionName)
    .map((sub) => `tmux ${sub.map(shellSingleQuoteIfNeeded).join(' ')}`)
    .join('; ');
}

/**
 * Wrap `s` in POSIX single quotes only if it contains characters that
 * shells (sh/bash/zsh) parse specially. Tmux args like `,*:extkeys` need
 * quoting (the `*` would glob); plain identifiers like `C-a` or `prefix`
 * don't. Keeping the unquoted form when safe makes the generated SSH
 * command easier to read in logs.
 */
function shellSingleQuoteIfNeeded(s: string): string {
  return /^[A-Za-z0-9_:.\/=+-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * The `docker` argv for an interactive login shell in a box — the same shape
 * `agentbox shell` uses (vscode user, image WORKDIR `/workspace`, `bash -l`).
 * Handed to node-pty by the dashboard's "open a shell" action.
 */
export function buildShellArgv(container: string): string[] {
  const term = process.env['TERM'] ?? 'xterm-256color';
  return ['exec', '-it', '-e', `TERM=${term}`, '--user', CONTAINER_USER, container, 'bash', '-l'];
}
