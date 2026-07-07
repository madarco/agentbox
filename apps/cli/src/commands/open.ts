import { log } from '@clack/prompts';
import { execa } from 'execa';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BoxRecord } from '@agentbox/core';
import {
  hostOpenCommand,
  ensureCloudSshAlias,
  recordBoxSsh,
  resolveCloudSshTarget,
  syncAgentboxSshConfig,
} from '@agentbox/sandbox-core';
import { inspectBox, openBoxInFinder, startBox, unpauseBox } from '@agentbox/sandbox-docker';
import { Command, InvalidArgumentError } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { hyperlink } from '../hyperlink.js';
import { providerForBox } from '../provider/registry.js';
import { spawnInNewTerminal } from '../terminal/host.js';
import { runPath } from './path.js';
import { handleLifecycleError } from './_errors.js';
import { runCodeOpen } from './code.js';
import {
  codexAddUrl,
  defaultHerdrSocketPath,
  detectOpenTargets,
  PERSISTENT_SSH_PROVIDERS,
  renderTargets,
  resolveCmuxBinary,
  type OpenTarget,
} from './_open-in.js';

interface OpenOpts {
  refresh: boolean; // commander gives `--no-refresh` => refresh=false
  includeNodeModules?: boolean;
  print?: boolean;
  path?: boolean;
  unmount?: boolean;
  in?: OpenTarget;
  targets?: boolean;
  json?: boolean;
}

function parseOpenTarget(value: string): OpenTarget {
  if (
    value === 'codex' ||
    value === 'herdr' ||
    value === 'cmux' ||
    value === 'vscode' ||
    value === 'iterm2' ||
    value === 'finder'
  ) {
    return value;
  }
  throw new InvalidArgumentError(
    `expected one of: codex, herdr, cmux, vscode, iterm2, finder (got "${value}")`,
  );
}

export const openCommand = new Command('open')
  .description(
    "Open a box in Finder (default; docker: rsync'd snapshot; cloud: sshfs mount) or in a host app via --in",
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--no-refresh', "skip the rsync; open whatever's already on disk (docker only)")
  .option(
    '--include-node-modules',
    'include /workspace/node_modules in the merged export (docker only; off by default)',
  )
  .option('--path', 'print the host workspace / mount path instead of launching Finder')
  .option('--print', 'alias of --path')
  .option(
    '--unmount',
    'cloud only: unmount any existing sshfs mount for the box and exit',
  )
  .option(
    '--in <app>',
    'open the box in a host app instead of Finder: codex | herdr | cmux | vscode | iterm2 | finder',
    parseOpenTarget,
  )
  .option('--targets', 'print which --in apps are installed on this host and exit (no box needed)')
  .option('--json', 'with --targets: machine-readable output')
  .action(async (idOrName: string | undefined, opts: OpenOpts) => {
    try {
      if (opts.targets) {
        const report = detectOpenTargets();
        process.stdout.write(opts.json ? JSON.stringify(report) + '\n' : renderTargets(report));
        return;
      }

      const box = await resolveBoxOrExit(idOrName);

      const app = opts.in ?? 'finder';
      if (app === 'codex') {
        await openInCodex(box);
        return;
      }
      if (app === 'herdr' || app === 'cmux' || app === 'iterm2') {
        await openInTerminalApp(box, app);
        return;
      }
      if (app === 'vscode') {
        await runCodeOpen(box, {});
        return;
      }

      const isCloud = (box.provider ?? 'docker') !== 'docker';

      if (isCloud) {
        await runCloudOpen(box, opts);
        return;
      }

      if (opts.path || opts.print) {
        await runPath(box, {
          refresh: opts.refresh, // print refreshes by default; --no-refresh skips
          includeNodeModules: opts.includeNodeModules,
        });
        return;
      }

      const result = await openBoxInFinder(box.id, {
        includeNodeModules: opts.includeNodeModules,
        noRefresh: !opts.refresh,
        noOpen: false,
      });

      const liveNote = !result.copied ? ' (live)' : result.usedFallback ? ' (tar fallback)' : '';
      process.stdout.write(`opened ${result.hostPath}${liveNote}\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

/**
 * `open --in codex`: write the box's SSH alias and auto-open Codex's
 * "add SSH connection" deep link, pre-filled with the alias — the same link
 * `agentbox shell --ssh-config` prints, but launched instead of printed.
 * Same gating as there: only providers with a persistent per-box identity
 * file qualify (Codex connects later on its own), and we gate BEFORE writing
 * so unsupported providers leave `~/.ssh/config` untouched.
 */
async function openInCodex(box: BoxRecord): Promise<void> {
  const providerName = box.provider ?? 'docker';
  if (!PERSISTENT_SSH_PROVIDERS.includes(providerName)) {
    throw new Error(
      `'--in codex' needs a box with a persistent SSH key — only Hetzner cloud boxes qualify ` +
        `(this box is '${providerName}'). Docker boxes aren't reachable over SSH and Daytona uses ` +
        `a 60-min token that expires. Try 'agentbox open ${box.name} --in vscode' instead.`,
    );
  }
  const provider = await providerForBox(box);
  const conn = await resolveCloudSshTarget(box, provider);
  if (!conn.identityFile) {
    throw new Error(
      `box '${box.name}' (provider '${providerName}') has no persistent SSH key, so it can't ` +
        `be added to Codex over SSH.`,
    );
  }
  await recordBoxSsh(box.id, {
    host: conn.host,
    user: conn.user,
    identityFile: conn.identityFile,
  });
  await syncAgentboxSshConfig();
  log.info(`ssh alias '${conn.alias}' written (Include'd from ~/.ssh/config)`);

  const url = codexAddUrl(conn.alias);
  const opened = await execa(hostOpenCommand(), [url], { reject: false });
  if (opened.exitCode !== 0) {
    log.warn(
      `could not auto-open the Codex link (is Codex.app installed?): ${opened.stderr || `exit ${String(opened.exitCode)}`}`,
    );
    const link = hyperlink(`Add ${conn.alias} to Codex SSH`, url, process.stdout);
    process.stdout.write(`open manually: ${link}\n${url}\n`);
    process.exitCode = 1;
    return;
  }
  log.success(`opening Codex — the SSH connection form is pre-filled with '${conn.alias}'`);
  process.stdout.write(url + '\n');
}

/**
 * `open --in herdr|cmux|iterm2`: bring the box online, then open a new
 * workspace/window in the host app running `agentbox attach <box>`. Works from
 * OUTSIDE the app: Herdr via its well-known session socket, cmux via its
 * control CLI (PATH or the macOS app bundle), iTerm2 via AppleScript (which
 * auto-launches it). cmux rejects external control clients unless the user
 * enables it — surface that as an actionable error, don't auto-configure.
 */
async function openInTerminalApp(box: BoxRecord, host: 'herdr' | 'cmux' | 'iterm2'): Promise<void> {
  // `agentbox attach` does not auto-start a box, so bring it online here —
  // otherwise the new pane just shows the "box is stopped" error.
  if ((box.provider ?? 'docker') === 'docker') {
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
  } else {
    const p = await providerForBox(box);
    const state = await p.probeState(box);
    if (state === 'paused') {
      log.info('box is paused; resuming');
      await p.resume(box);
    } else if (state === 'stopped') {
      log.info('box is stopped; starting');
      await p.start(box);
    } else if (state === 'missing') {
      throw new Error(`cloud sandbox for ${box.name} is missing; was it deleted?`);
    }
  }

  // This command usually runs from a plain terminal (or the tray app), where
  // the in-app env vars are absent — resolve the app's control channel
  // explicitly and inject it, so the spawn helpers work unchanged.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (host === 'herdr' && !env['HERDR_SOCKET_PATH']) {
    const sock = defaultHerdrSocketPath();
    if (!sock) {
      throw new Error(
        `Herdr socket not found (~/.config/herdr/herdr.sock). Is Herdr running? ` +
          `Set up the integration with 'agentbox install herdr'.`,
      );
    }
    env['HERDR_SOCKET_PATH'] = sock;
  }
  if (host === 'cmux') {
    const bin = resolveCmuxBinary();
    if (!bin) {
      throw new Error(
        `cmux CLI not found — not on PATH and no /Applications/cmux.app. Install cmux first.`,
      );
    }
    env['CMUX_BUNDLED_CLI_PATH'] = bin;
  }

  const cwd = box.workspacePath || box.projectRoot || homedir();
  // `--inline` keeps the attach in the pane we just created — without it the
  // attach process (now running inside the app, env vars set) would honor
  // `attach.openIn` and spawn yet another tab, stranding a bare shell.
  const r = await spawnInNewTerminal({
    host,
    mode: 'window',
    argv: [process.execPath, process.argv[1] ?? 'agentbox', 'attach', box.name, '--inline'],
    cwd,
    title: box.name,
    env,
    // A failed attach (e.g. no agent session yet) should leave a usable shell
    // in the new pane, not a closed one.
    keepShell: true,
  });
  if (!r.launched) {
    if (host === 'cmux' && /password|auth|denied|unauthorized|control/i.test(r.error ?? '')) {
      throw new Error(
        `cmux refused the control connection — external processes can't drive it by default. ` +
          `In cmux Settings enable socketControlMode "automation", or set a socket password ` +
          `(Settings, or CMUX_SOCKET_PASSWORD).\n${r.error ?? ''}`,
      );
    }
    const hint =
      host === 'herdr'
        ? ' Is Herdr running? (`herdr status server`)'
        : host === 'cmux'
          ? ' Is cmux running?'
          : ' Is iTerm2 installed?';
    throw new Error(`could not open in ${host}: ${r.error ?? 'unknown error'}.${hint}`);
  }
  log.success(`opened ${box.name} in a new ${host} ${host === 'iterm2' ? 'window' : 'workspace'} (agentbox attach)`);
}

/**
 * Cloud `open`: mount the sandbox's `/workspace` via sshfs at a per-box host
 * path (`~/.agentbox/mounts/<box-name>/`) and reveal in Finder. Reuses the
 * SSH alias `agentbox code` already manages — the alias maps to a fresh
 * 60-min Daytona SSH token, written into `~/.ssh/config` per call so sshfs
 * has a live target without baking the token into the mount itself.
 */
async function runCloudOpen(box: BoxRecord, opts: OpenOpts): Promise<void> {
  const mountRoot = join(homedir(), '.agentbox', 'mounts', box.name);

  if (opts.unmount) {
    const ok = await tryUnmount(mountRoot);
    if (ok) process.stdout.write(`unmounted ${mountRoot}\n`);
    else process.stdout.write(`nothing mounted at ${mountRoot}\n`);
    return;
  }

  if (opts.path || opts.print) {
    // Don't mount when we only print — print is meant to be lightweight.
    process.stdout.write(`${mountRoot}\n`);
    return;
  }

  // sshfs is the load-bearing dep; macFUSE + sshfs are typically installed
  // via `brew install macfuse sshfs`. Fail with a clear hint instead of
  // a cryptic ENOENT.
  const sshfsBin = await locateBinary('sshfs');
  if (!sshfsBin) {
    throw new Error(
      'sshfs not found on PATH. Install with `brew install macfuse sshfs` (macOS) or your distro\'s package manager, then retry. Cloud `agentbox open` mounts the sandbox /workspace via sshfs.',
    );
  }

  // Same SSH alias machinery `agentbox code` uses — bring the box online and
  // (re)write the alias (a fresh 60-min token for Daytona) so sshfs gets a live
  // mount target.
  const provider = await providerForBox(box);
  const { alias } = await ensureCloudSshAlias(box, provider);

  // Ensure the mount dir exists. If something's already mounted there (a
  // stale mount from a previous run) we tear it down before re-mounting —
  // sshfs would otherwise error with "mountpoint is not empty".
  if (!existsSync(mountRoot)) {
    mkdirSync(mountRoot, { recursive: true, mode: 0o755 });
  } else if (await isMounted(mountRoot)) {
    log.info(`re-mounting (stale mount detected at ${mountRoot})`);
    await tryUnmount(mountRoot);
  }

  log.info(`mounting ${alias}:/workspace at ${mountRoot}`);
  const mount = await execa(
    sshfsBin,
    [
      `${alias}:/workspace`,
      mountRoot,
      // Foreground would block the CLI; default backgrounds the helper.
      '-o',
      'reconnect',
      '-o',
      // `volname` makes Finder show a friendly label instead of `osxfuseN`.
      `volname=agentbox-${box.name}`,
      '-o',
      'noappledouble',
    ],
    { reject: false },
  );
  if (mount.exitCode !== 0) {
    throw new Error(`sshfs mount failed (exit ${String(mount.exitCode)}): ${mount.stderr || mount.stdout}`);
  }
  // Reveal the mount in the OS file manager (Finder on macOS, the default
  // handler via xdg-open on Linux). Best-effort — the mount path is already
  // printed, so a missing opener degrades silently.
  await execa(hostOpenCommand(), [mountRoot], { reject: false });
  process.stdout.write(`opened ${mountRoot}\n`);
  process.stdout.write(`unmount later with: agentbox open ${box.name} --unmount\n`);
}

async function locateBinary(name: string): Promise<string | null> {
  const r = await execa('which', [name], { reject: false });
  if (r.exitCode !== 0) return null;
  const path = (r.stdout ?? '').trim();
  return path.length > 0 ? path : null;
}

async function isMounted(path: string): Promise<boolean> {
  // `mount` prints "on <path>" entries; grep for the mountpoint. macOS and
  // Linux both report it. Fallback to "false" on any exec error so we don't
  // wedge on a missing util.
  const r = await execa('sh', ['-c', `mount | grep -F " on ${path} "`], { reject: false });
  return r.exitCode === 0;
}

async function tryUnmount(path: string): Promise<boolean> {
  // macOS prefers `umount`; some setups need `diskutil unmount`. Try both.
  if (await isMounted(path)) {
    const u = await execa('umount', [path], { reject: false });
    if (u.exitCode === 0) return true;
    const d = await execa('diskutil', ['unmount', path], { reject: false });
    return d.exitCode === 0;
  }
  return false;
}

