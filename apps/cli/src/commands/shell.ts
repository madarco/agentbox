import { spawnSync } from 'node:child_process';
import { log } from '@clack/prompts';
import { Command } from 'commander';
import { loadEffectiveConfig, type UserConfig } from '@agentbox/config';
import {
  allocateShellSessionName,
  buildShellSessionAttachArgv,
  DEFAULT_RELAY_PORT,
  DEFAULT_SHELL_SESSION,
  formatDetachNotice,
  inspectBox,
  killShellSession,
  listShellSessions,
  parseShellSessionList,
  shellLabel,
  shellSessionInfo,
  shellSessionName,
  startBox,
  startShellSession,
  unpauseBox,
  type BoxRecord,
  type ShellSessionSummary,
} from '@agentbox/sandbox-docker';
import { resolveBoxOrExit, resolveBoxOrShift } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import {
  recordBoxSsh,
  resolveCloudSshTarget,
  agentboxSshConfigPath,
  hasUnmanagedHostConflict,
  syncAgentboxSshConfig,
} from '@agentbox/sandbox-core';
import { hyperlink } from '../hyperlink.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';
import { handleLifecycleError } from './_errors.js';
import { requireDockerProvider } from './_provider-guard.js';

const RELAY_HOST_URL = `http://127.0.0.1:${String(DEFAULT_RELAY_PORT)}`;

interface ShellOptions {
  user?: string;
  login?: boolean;
  tmux?: boolean; // commander: --no-tmux => false; default true
  /** -n/--name: the shell label (default shell when unset). */
  name?: string;
  /** --new: open a fresh auto-numbered shell instead of the default. */
  new?: boolean;
  /** --ssh-config: write a ~/.ssh/config alias for external apps instead of opening a shell. */
  sshConfig?: boolean;
  /** --json: machine-readable output (only meaningful with --ssh-config). */
  json?: boolean;
}

function buildShellCliOverrides(opts: ShellOptions): Partial<UserConfig> {
  const shell: NonNullable<UserConfig['shell']> = {};
  if (opts.user !== undefined) shell.user = opts.user;
  if (opts.login === false) shell.login = false;
  if (opts.tmux === false) shell.tmux = false;
  return Object.keys(shell).length > 0 ? { shell } : {};
}

/** Ref shown in the detach notice: the per-project index `n` when set
 *  (resolves from inside the project dir), else the globally-unique name. */
function reattachRef(r: { projectIndex?: number; name: string }): string {
  return typeof r.projectIndex === 'number' ? String(r.projectIndex) : r.name;
}

/** ` -n <label>` suffix for the reattach hint — empty for the default shell. */
function detachSuffix(sessionName: string): string {
  const label = shellLabel(sessionName);
  return label === DEFAULT_SHELL_SESSION ? '' : ` -n ${label}`;
}

/**
 * `bash` argv for a one-shot `agentbox shell <box> -- <cmd...>`.
 *
 * A single token is a shell snippet — `bash -lc "<snippet>"` — so
 * `-- "cd x && npm test"` and `-- 'echo $HOME'` keep working (the box's shell
 * interprets operators/expansions). Multiple tokens are an argv that must reach
 * the box verbatim: joining them into one string and re-parsing through
 * `bash -c` double-parses the user's quoting (this is the bug — it mangled
 * `-- bash -lc "echo 'x' > f"` and split `-- curl -w "...%{http_code}..."`).
 * We instead hand the tokens to `exec "$@"` as positional params so each is
 * delivered literally, while still running under the login shell (`-l`) so the
 * profile's PATH is in scope before the exec.
 *
 * Mirrors how `docker exec <c> <argv...>` / execve treat an explicit argv,
 * with the single-string convenience preserved for shell one-liners.
 */
export function oneShotBashArgv(cmd: string[], login: boolean): string[] {
  const flag = login ? '-lc' : '-c';
  if (cmd.length <= 1) return ['bash', flag, cmd[0] ?? ''];
  return ['bash', flag, 'exec "$@"', 'bash', ...cmd];
}

/** Compact relative time, e.g. `3m ago`; `-` when unknown. */
function fmtAgo(iso: string | null): string {
  if (!iso) return '-';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${String(h)}h ago`;
  return `${String(Math.round(h / 24))}d ago`;
}

/** Auto-unpause/start the box so it's running. Mirrors `agentbox code` /
 *  `agentbox claude start`. `startBox` relaunches ctl/vnc/dockerd. */
async function ensureBoxRunning(box: BoxRecord): Promise<void> {
  const insp = await inspectBox(box.id);
  if (insp.state === 'paused') {
    log.info('box is paused; unpausing');
    await unpauseBox(box.id);
  } else if (insp.state === 'stopped') {
    log.info('box is stopped; starting');
    await startBox(box.id);
  } else if (insp.state === 'missing') {
    throw new Error(`box ${box.name} has no container; was it destroyed?`);
  }
}

/**
 * Resolve which tmux session `agentbox shell` should target: an explicit
 * `-n <label>` wins; `--new` allocates the lowest-free `shell-N`; otherwise
 * the box's default `shell`.
 */
async function resolveTargetSession(
  box: BoxRecord,
  user: string,
  opts: ShellOptions,
): Promise<string> {
  if (opts.name !== undefined && opts.name.trim() !== '') {
    return shellSessionName(opts.name);
  }
  if (opts.new) {
    const existing = await listShellSessions(box.container, user);
    return allocateShellSessionName(existing.map((s) => s.sessionName));
  }
  return DEFAULT_SHELL_SESSION;
}

/**
 * Cloud equivalent of {@link resolveTargetSession}. Lists tmux sessions
 * over `provider.exec` (`tmux list-sessions -F …` over SSH) and reuses
 * the pure-string `allocateShellSessionName` helper. Empty list / tmux
 * server not running / exec failure all degrade to "default `shell`".
 */
async function resolveCloudShellSessionName(
  box: BoxRecord,
  provider: { exec: (b: BoxRecord, argv: string[], opts?: { user?: string }) => Promise<{ exitCode: number; stdout: string }> },
  user: string,
  opts: ShellOptions,
): Promise<string> {
  if (opts.name !== undefined && opts.name.trim() !== '') {
    return shellSessionName(opts.name);
  }
  if (!opts.new) return DEFAULT_SHELL_SESSION;
  const r = await provider
    .exec(
      box,
      [
        'tmux',
        'list-sessions',
        '-F',
        '#{session_name}\t#{session_created}\t#{session_attached}',
      ],
      { user },
    )
    .catch(() => ({ exitCode: 1, stdout: '' }));
  // tmux server-not-running prints "no server running" on stderr and exits 1.
  // Empty session list → use the default name.
  if (r.exitCode !== 0) return DEFAULT_SHELL_SESSION;
  const existing = parseShellSessionList(r.stdout).map((s) => s.sessionName);
  return allocateShellSessionName(existing);
}

interface ShellSessionCfg {
  user: string;
  login: boolean;
  sessionName: string;
}

/**
 * Start-or-attach a box's shell tmux session, then hand the docker
 * tmux-attach argv to the node-pty wrapper (footer + `Ctrl+a d` detach).
 * Process-exits with the inner pty's code. The box must already be running.
 */
async function startOrAttachShell(box: BoxRecord, cfg: ShellSessionCfg): Promise<never> {
  const label = shellLabel(cfg.sessionName);
  const info = await shellSessionInfo(box.container, cfg.sessionName, cfg.user);
  if (info.running) {
    log.info(`reattaching to shell "${label}" — Control+a d to detach`);
  } else {
    await startShellSession({
      container: box.container,
      sessionName: cfg.sessionName,
      user: cfg.user,
      login: cfg.login,
    });
    log.info(`shell "${label}" — Control+a d to detach, leaves it running`);
  }
  const code = await runWrappedAttach({
    container: box.container,
    dockerArgv: buildShellSessionAttachArgv(box.container, cfg.sessionName, cfg.user),
    relayBaseUrl: RELAY_HOST_URL,
    boxId: box.id,
    boxName: box.name,
    projectIndex: box.projectIndex,
    mode: 'shell',
    detachable: true,
    detachNotice: formatDetachNotice(reattachRef(box), 'shell', detachSuffix(cfg.sessionName)),
  });
  process.exit(code);
}

/**
 * `agentbox shell <box> --ssh-config`: write the box's `~/.ssh/config` alias and
 * print connection details so an external app (the Codex app, Claude desktop)
 * can connect over plain SSH — instead of opening a shell.
 *
 * Only providers with a *persistent* per-box identity file qualify: an external
 * app connects later, so a token-in-User credential that expires (Daytona) is
 * useless, and Docker/Vercel/E2B have no SSH at all. We resolve the target
 * first and gate on `identityFile` BEFORE writing, so unsupported providers
 * leave `~/.ssh/config` untouched.
 */
async function runSshConfig(box: BoxRecord, opts: ShellOptions): Promise<void> {
  const provider = await providerForBox(box);
  const conn = await resolveCloudSshTarget(box, provider);
  if (!conn.identityFile) {
    throw new Error(
      `box '${box.name}' (provider '${box.provider ?? 'docker'}') has no persistent SSH key, ` +
        `so it can't be added to Codex / Claude desktop over SSH. Only Hetzner cloud boxes are ` +
        `supported — Docker boxes aren't reachable over SSH, and Daytona uses a 60-min token that expires.`,
    );
  }
  // The alias is the bare box name; warn (don't fail) if the user already has
  // their own `Host <name>`. Our managed `Include` is prepended, so OpenSSH
  // (first value per keyword) now applies agentbox's entry — silently shadowing
  // the user's, which may not be what they expect.
  if (await hasUnmanagedHostConflict(conn.alias)) {
    log.warn(
      `~/.ssh/config already has a non-agentbox \`Host ${conn.alias}\` entry. agentbox's ` +
        `Include is prepended, so SSH applies agentbox's HostName/IdentityFile first and your ` +
        `entry is ignored — rename the box (or remove your entry) if you meant yours to win.`,
    );
  }

  await recordBoxSsh(box.id, {
    host: conn.host,
    user: conn.user,
    identityFile: conn.identityFile,
  });
  await syncAgentboxSshConfig();

  const codexUrl = `codex://settings/connections/ssh/add?name=${encodeURIComponent(conn.alias)}`;
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          alias: conn.alias,
          host: conn.host,
          user: conn.user,
          identityFile: conn.identityFile,
          sshCommand: `ssh ${conn.alias}`,
          codexAddUrl: codexUrl,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const codexLink = hyperlink(`Add ${conn.alias} to Codex SSH`, codexUrl, process.stdout);
  const lines = [
    `wrote ${agentboxSshConfigPath()} entry "${conn.alias}" (Include'd from ~/.ssh/config)`,
    ``,
    `ssh alias:      ${conn.alias}`,
    `host:           ${conn.host}`,
    `user:           ${conn.user}`,
    `identity:       ${conn.identityFile}`,
    `connect:        ssh ${conn.alias}`,
    ``,
    `Codex:          ${codexLink}`,
    `                ${codexUrl}`,
    `Claude desktop: add an SSH connection to host "${conn.alias}" (already in ~/.ssh/config)`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

export const shellCommand = new Command('shell')
  .description(
    'Open an interactive shell in a box, in a detachable tmux session (auto-unpause/start)',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .argument(
    '[cmd...]',
    'optional one-shot command to run instead of an interactive shell; place after `--`, e.g. `agentbox shell smoke -- ls /workspace`',
  )
  .option('--user <name>', 'user inside the container (default from config; built-in: vscode)')
  .option('--no-login', 'invoke `bash` instead of `bash -l` (skip login profile)')
  .option('--no-tmux', 'run a plain docker exec shell instead of a detachable tmux session')
  .option('-n, --name <label>', 'open/attach a named shell session (a box can hold several)')
  .option('--new', 'open a fresh, auto-numbered shell session (shell-2, shell-3, ...)')
  .option(
    '--ssh-config',
    'write a ~/.ssh/config alias for this box (Hetzner cloud boxes) and print connection details for Codex / Claude desktop, instead of opening a shell',
  )
  .option('--json', 'with --ssh-config: emit the connection details as JSON')
  .action(async (idOrName: string | undefined, cmd: string[], opts: ShellOptions) => {
    try {
      // resolveBoxOrShift handles the `agentbox shell -- ls` case: commander
      // binds "ls" to [box], which doesn't resolve; if auto-pick succeeds we
      // treat "ls" as the first cmd token instead.
      const { box, shifted } = await resolveBoxOrShift(idOrName);
      const effectiveCmd = shifted && idOrName ? [idOrName, ...cmd] : cmd;

      // `--ssh-config` short-circuits the shell: it only writes the SSH alias
      // and prints connection details for external apps.
      if (opts.sshConfig) {
        await runSshConfig(box, opts);
        return;
      }

      const cfg = await loadEffectiveConfig(box.workspacePath, {
        cliOverrides: buildShellCliOverrides(opts),
      });
      const user = cfg.effective.shell.user;
      const login = cfg.effective.shell.login;
      const tmux = cfg.effective.shell.tmux;

      // Cloud boxes: attach via SSH (provider.buildAttach), not docker exec.
      // The flow keeps the same options (tmux session, one-shot cmd, etc.)
      // but goes over the SSH token Daytona mints per attach.
      if ((box.provider ?? 'docker') !== 'docker') {
        const provider = await providerForBox(box);
        const oneShot = effectiveCmd.length > 0;

        // One-shot (`agentbox shell <box> -- cmd`) goes through the backend
        // `exec` primitive, not the interactive PTY attach. The PTY path
        // (buildAttach) always allocates a TTY and the wrapper waits for it
        // to close — fine for `tmux attach`, but hangs forever on a plain
        // `whoami`. exec is the same primitive used at create-time and for
        // file ops; it returns when the command exits.
        if (oneShot) {
          const argv = oneShotBashArgv(effectiveCmd, login);
          const r = await provider.exec(box, argv, { user });
          if (r.stdout) process.stdout.write(r.stdout);
          if (r.stderr) process.stderr.write(r.stderr);
          process.exit(r.exitCode);
        }

        if (!provider.buildAttach) {
          throw new Error(`provider '${provider.name}' does not support interactive attach`);
        }
        const innerCmd = login ? 'bash -l' : 'bash';
        // Resolve `--name` / `--new` like the docker branch: list existing
        // tmux shell sessions over SSH (`tmux list-sessions -F ...`) and
        // pick the next free `shell-N`. The session naming helpers in
        // sandbox-docker are pure string ops — safe to reuse here.
        const sessionName = await resolveCloudShellSessionName(box, provider, user, opts);
        const spec = await provider.buildAttach(box, 'shell', {
          sessionName,
          user,
          command: innerCmd,
          // `--no-tmux` skips the tmux wrap. (One-shot exited above.)
          noTmux: !tmux,
        });
        try {
          const code = await runWrappedAttach({
            container: box.name,
            command: spec.argv[0],
            dockerArgv: spec.argv.slice(1),
            env: spec.env,
            relayBaseUrl: RELAY_HOST_URL,
            boxId: box.id,
            boxName: box.name,
            projectIndex: box.projectIndex,
            mode: 'shell',
            detachable: tmux,
          });
          process.exit(code);
        } finally {
          if (spec.cleanup) await spec.cleanup();
        }
      }

      await ensureBoxRunning(box);

      // Inherit TERM so bash declares the outer terminal's true-color +
      // hyperlink capabilities (docker exec defaults to TERM=xterm).
      const term = process.env['TERM'] ?? 'xterm-256color';

      // -i always (so stdin pipes / heredocs work). -t only when stdout is a
      // real TTY — `docker exec -t` errors with "cannot attach stdin to a
      // TTY-enabled container because stdin is not a terminal" when run under
      // a script or another agent that piped its output.
      const isInteractive = process.stdout.isTTY && process.stdin.isTTY;

      // Plain `docker exec` argv — used for one-shot `-- cmd`, non-interactive
      // runs, and the interactive `--no-tmux` shell. One-shot/piped use is
      // never tmux-wrapped: machine-readable stdout and heredocs must stay
      // clean.
      // One-shot (`-- cmd…`) runs the command argv verbatim (see oneShotBashArgv);
      // no cmd → an interactive `bash`/`bash -l` shell.
      const bashInvocation =
        effectiveCmd.length > 0
          ? oneShotBashArgv(effectiveCmd, login)
          : login
            ? ['bash', '-l']
            : ['bash'];
      const ttyFlag = isInteractive ? '-it' : '-i';
      const plainArgv = [
        'exec',
        ttyFlag,
        '-e',
        `TERM=${term}`,
        '--user',
        user,
        box.container,
        ...bashInvocation,
      ];

      // One-shot exec (`agentbox shell box -- cmd…`) and any piped use both
      // need machine-readable stdout — the wrapped pty would corrupt it with
      // a footer, and a tmux session makes no sense. Stay on the plain
      // spawnSync path in those cases (`-n` / `--new` don't apply).
      if (!isInteractive || effectiveCmd.length > 0) {
        const child = spawnSync('docker', plainArgv, { stdio: 'inherit' });
        process.exit(child.status ?? 0);
      }

      // Interactive shell. Default: run inside a detachable tmux session so
      // `Ctrl+a d` leaves it running (reattach with `agentbox shell attach`).
      // `--no-tmux` keeps the plain wrapped `docker exec` shell — closing the
      // terminal kills it.
      if (tmux) {
        const sessionName = await resolveTargetSession(box, user, opts);
        await startOrAttachShell(box, { user, login, sessionName });
      }
      const code = await runWrappedAttach({
        container: box.container,
        dockerArgv: plainArgv,
        relayBaseUrl: RELAY_HOST_URL,
        boxId: box.id,
        boxName: box.name,
        projectIndex: box.projectIndex,
        mode: 'shell',
      });
      process.exit(code);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const shellAttachCommand = new Command('attach')
  .description(
    'Attach to a shell tmux session in a box, starting one if none is running (auto-unpause/start)',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--user <name>', 'user inside the container (default from config; built-in: vscode)')
  .option('--no-login', 'invoke `bash` instead of `bash -l` (skip login profile)')
  .option('-n, --name <label>', 'shell label to attach (default: the box default shell)')
  .action(async function (this: Command, idOrName: string | undefined) {
    try {
      if (!process.stdout.isTTY || !process.stdin.isTTY) {
        throw new Error('`agentbox shell attach` needs an interactive terminal.');
      }
      // optsWithGlobals merges parent + own options — the parent `shell`
      // command also defines `-n/--name`, so it parses the flag and this
      // subcommand reads it back through the merge.
      const opts = this.optsWithGlobals() as ShellOptions;
      const box = await resolveBoxOrExit(idOrName);
      requireDockerProvider(box, 'shell');
      const cfg = await loadEffectiveConfig(box.workspacePath, {
        cliOverrides: buildShellCliOverrides(opts),
      });
      await ensureBoxRunning(box);
      await startOrAttachShell(box, {
        user: cfg.effective.shell.user,
        login: cfg.effective.shell.login,
        sessionName: shellSessionName(opts.name),
      });
    } catch (err) {
      handleLifecycleError(err);
    }
  });

function renderShellTable(sessions: ShellSessionSummary[]): void {
  const header = ['SHELL', 'ATTACHED', 'CREATED'];
  const rows = sessions.map((s) => [s.label, s.attached ? 'attached' : '-', fmtAgo(s.createdAt)]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  process.stdout.write(`${fmt(header)}\n`);
  for (const r of rows) process.stdout.write(`${fmt(r)}\n`);
}

const shellLsCommand = new Command('ls')
  .description('List the shell tmux sessions running in a box')
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .action(async (idOrName: string | undefined) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      requireDockerProvider(box, 'shell');
      const insp = await inspectBox(box.id);
      if (insp.state !== 'running') {
        log.info(`box ${box.name} is ${insp.state} — no live shell sessions`);
        return;
      }
      if (insp.shellSessions.length === 0) {
        log.info(
          `no shell sessions in ${box.name} — start one with: agentbox shell ${reattachRef(box)}`,
        );
        return;
      }
      renderShellTable(insp.shellSessions);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

interface ShellKillOptions {
  name?: string;
  all?: boolean;
}

const shellKillCommand = new Command('kill')
  .description('Kill a shell tmux session in a box (the shell and anything running in it)')
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('-n, --name <label>', 'shell label to kill (default: the box default shell)')
  .option('--all', 'kill every shell session in the box')
  .action(async function (this: Command, idOrName: string | undefined) {
    try {
      // optsWithGlobals: the parent `shell` command also defines `-n/--name`
      // (it parses the flag); `--all` is this subcommand's own.
      const opts = this.optsWithGlobals() as ShellKillOptions;
      const box = await resolveBoxOrExit(idOrName);
      requireDockerProvider(box, 'shell');
      const insp = await inspectBox(box.id);
      if (insp.state !== 'running') {
        log.info(`box ${box.name} is ${insp.state} — no shell sessions to kill`);
        return;
      }
      if (opts.all) {
        if (insp.shellSessions.length === 0) {
          log.info(`no shell sessions in ${box.name}`);
          return;
        }
        let killed = 0;
        for (const s of insp.shellSessions) {
          if (await killShellSession(box.container, s.sessionName)) killed++;
        }
        log.success(`killed ${String(killed)} shell session${killed === 1 ? '' : 's'} in ${box.name}`);
        return;
      }
      const target = shellSessionName(opts.name);
      const ok = await killShellSession(box.container, target);
      if (ok) log.success(`killed shell "${shellLabel(target)}" in ${box.name}`);
      else log.warn(`no shell "${shellLabel(target)}" in ${box.name} (already gone?)`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

shellCommand.addCommand(shellAttachCommand);
shellCommand.addCommand(shellLsCommand);
shellCommand.addCommand(shellKillCommand);
