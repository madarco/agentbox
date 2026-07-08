import { log } from '@clack/prompts';
import { execa } from 'execa';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BoxRecord } from '@agentbox/core';
import {
  agentboxAliasFor,
  claudeSettingsPath,
  claudeSshEntryFor,
  hostOpenCommand,
  ensureCloudSshAlias,
  recordBoxSsh,
  resolveCloudSshTarget,
  syncAgentboxSshConfig,
  upsertClaudeSshConfig,
} from '@agentbox/sandbox-core';
import {
  inspectBox,
  openBoxInFinder,
  refreshBoxSshd,
  startBox,
  unpauseBox,
} from '@agentbox/sandbox-docker';
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
  SSH_MOUNT_PROVIDERS,
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
    value === 'claude' ||
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
    `expected one of: claude, codex, herdr, cmux, vscode, iterm2, finder (got "${value}")`,
  );
}

export const openCommand = new Command('open')
  .description(
    'Mount a box /workspace via sshfs and reveal in Finder (default), or open it in a host app via --in',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--no-refresh', "legacy docker (no sshd) only: skip the rsync; open what's on disk")
  .option(
    '--include-node-modules',
    'legacy docker (no sshd) only: include /workspace/node_modules in the export',
  )
  .option('--path', 'print the host mount path instead of launching Finder')
  .option('--print', 'alias of --path')
  .option(
    '--unmount',
    'unmount any existing sshfs mount for the box and exit',
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

      // `--unmount` is a pure host-side mount teardown — independent of the box's
      // provider or whether it currently has sshd — so handle it up front before
      // any provider dispatch (a legacy docker box would otherwise fall through to
      // the rsync path and never unmount).
      if (opts.unmount) {
        const mountRoot = join(homedir(), '.agentbox', 'mounts', box.name);
        const ok = await tryUnmount(mountRoot);
        process.stdout.write(ok ? `unmounted ${mountRoot}\n` : `nothing mounted at ${mountRoot}\n`);
        return;
      }

      const app = opts.in ?? 'finder';
      if (app === 'claude') {
        await openInClaude(box);
        return;
      }
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

      const providerName = box.provider ?? 'docker';

      // Live sshfs mount of /workspace for any SSH-capable provider (docker's
      // localhost sshd, Hetzner's VPS, Daytona's token gateway). A docker box
      // that predates the localhost sshd (no `sshEnabled`) still falls through to
      // the rsync-snapshot export below.
      if (SSH_MOUNT_PROVIDERS.includes(providerName) && (providerName !== 'docker' || box.sshEnabled)) {
        await runSshfsMount(box, opts);
        return;
      }

      // Providers with no SSH (vercel, e2b) can't be sshfs-mounted and have no
      // docker-style host export. Fail fast with a readable pointer — before any
      // bring-online — instead of a cryptic SSH-parse error deeper in.
      if (providerName !== 'docker') {
        throw new Error(
          `'agentbox open' live-mounts /workspace over sshfs, which ${providerName} boxes don't ` +
            `support (no SSH). Use 'agentbox download ${box.name}' to copy files to your host, ` +
            `or 'agentbox open ${box.name} --in vscode'.`,
        );
      }

      // Legacy docker box (no localhost sshd): rsync the merged /workspace export
      // to a host dir and reveal in Finder. Kept until this moves under `download`.
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
 * Persistent-SSH gate + alias write shared by the "register the box in a
 * desktop app" targets (Codex, Claude). Both apps connect later on their own,
 * so only providers with a persistent per-box identity qualify, and we gate
 * BEFORE writing so unsupported providers leave `~/.ssh/config` untouched.
 * Returns the box's ssh alias, freshly (re)synced into `~/.agentbox/ssh/config`.
 */
async function ensurePersistentSshAlias(box: BoxRecord, appLabel: string): Promise<string> {
  const providerName = box.provider ?? 'docker';
  if (!PERSISTENT_SSH_PROVIDERS.includes(providerName)) {
    throw new Error(
      `'--in ${appLabel.toLowerCase()}' needs a box with a persistent SSH key — docker (localhost sshd) and ` +
        `Hetzner cloud boxes qualify (this box is '${providerName}'). Daytona uses a 60-min ` +
        `token that expires; Vercel/E2B have no SSH. Try 'agentbox open ${box.name} --in vscode'.`,
    );
  }

  // A docker box created before the localhost sshd shipped has no SSH surface —
  // `PERSISTENT_SSH_PROVIDERS` gates by provider, so catch that here with a clear
  // message instead of a confusing "sshd may have failed to start" downstream.
  if (providerName === 'docker' && !box.sshEnabled) {
    throw new Error(
      `box '${box.name}' predates the in-box sshd, so it can't be added to ${appLabel} over SSH. ` +
        `Recreate the box (new docker boxes run sshd), or use 'agentbox open ${box.name} --in vscode'.`,
    );
  }

  if (providerName === 'docker') {
    // Docker: bring the box online (sshd up + loopback port fresh) and use the
    // alias create/start already wrote to `~/.ssh/config`.
    let online = await bringDockerBoxOnline(box);
    if (!online.ssh) online = await resolveBoxOrExit(online.id);
    if (!online.ssh?.identityFile) {
      throw new Error(
        `box '${box.name}' has no SSH key on disk — its in-box sshd may have failed to start. ` +
          `Try 'agentbox start ${box.name}' and retry.`,
      );
    }
    await syncAgentboxSshConfig();
    return agentboxAliasFor(online.name);
  }

  const provider = await providerForBox(box);
  const conn = await resolveCloudSshTarget(box, provider);
  if (!conn.identityFile) {
    throw new Error(
      `box '${box.name}' (provider '${providerName}') has no persistent SSH key, so it can't ` +
        `be added to ${appLabel} over SSH.`,
    );
  }
  await recordBoxSsh(box.id, {
    host: conn.host,
    user: conn.user,
    identityFile: conn.identityFile,
  });
  await syncAgentboxSshConfig();
  return conn.alias;
}

/**
 * `open --in codex`: write the box's SSH alias and auto-open Codex's
 * "add SSH connection" deep link, pre-filled with the alias — the same link
 * `agentbox shell --ssh-config` prints, but launched instead of printed.
 */
async function openInCodex(box: BoxRecord): Promise<void> {
  const alias = await ensurePersistentSshAlias(box, 'Codex');
  log.info(`ssh alias '${alias}' written (Include'd from ~/.ssh/config)`);

  const url = codexAddUrl(alias);
  const opened = await execa(hostOpenCommand(), [url], { reject: false });
  if (opened.exitCode !== 0) {
    log.warn(
      `could not auto-open the Codex link (is Codex.app installed?): ${opened.stderr || `exit ${String(opened.exitCode)}`}`,
    );
    const link = hyperlink(`Add ${alias} to Codex SSH`, url, process.stdout);
    process.stdout.write(`open manually: ${link}\n${url}\n`);
    process.exitCode = 1;
    return;
  }
  log.success(`opening Codex — the SSH connection form is pre-filled with '${alias}'`);
  process.stdout.write(url + '\n');
}

/**
 * `open --in claude`: register the box in the Claude desktop app. Claude has
 * no add-SSH deep link, but it reads SSH environments from its own settings
 * (`~/.claude/settings.json` → `sshConfigs`, and `sshHost` accepts an alias
 * from `~/.ssh/config`) — so write the box's alias there directly and launch
 * the app; the box shows up in its Environment dropdown, where the app can
 * also list/resume the box's existing Claude sessions over SSH.
 */
async function openInClaude(box: BoxRecord): Promise<void> {
  const alias = await ensurePersistentSshAlias(box, 'Claude');
  log.info(`ssh alias '${alias}' written (Include'd from ~/.ssh/config)`);

  const entry = claudeSshEntryFor(alias, box.name);
  upsertClaudeSshConfig(entry);
  log.info(`added '${entry.name}' to Claude desktop's SSH connections (${claudeSettingsPath()})`);

  const opened = await execa(hostOpenCommand(), ['-a', 'Claude'], { reject: false });
  if (opened.exitCode !== 0) {
    log.warn(
      `could not launch Claude (is Claude.app installed?): ${opened.stderr || `exit ${String(opened.exitCode)}`}`,
    );
    process.stdout.write(
      `the SSH connection '${entry.name}' is saved — open Claude manually and pick it from the Environment dropdown\n`,
    );
    process.exitCode = 1;
    return;
  }
  log.success(`opening Claude — pick '${entry.name}' from the Environment dropdown`);
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
 * Bring a docker box online (unpause/start) and return the freshest record with
 * a live SSH target. `startBox` already re-resolves the ephemeral sshd host port;
 * for a box that is *already running*, we still `refreshBoxSshd` because a
 * `docker restart` (or docker daemon restart) outside `agentbox start`
 * reallocates the `-p 0:22` host port, leaving the recorded `Port` stale.
 */
async function bringDockerBoxOnline(box: BoxRecord): Promise<BoxRecord> {
  const insp = await inspectBox(box.id);
  if (insp.state === 'paused') {
    log.info('box is paused; unpausing');
    await unpauseBox(box.id);
  } else if (insp.state === 'stopped') {
    log.info('box is stopped; starting');
    const started = await startBox(box.id);
    return started.record;
  } else if (insp.state === 'missing') {
    throw new Error(`box ${box.name} has no container; was it destroyed?`);
  }
  // Already running (or just unpaused): re-verify the sshd port is current.
  return await refreshBoxSshd(box);
}

/**
 * `open`: mount the box's `/workspace` via sshfs at a per-box host path
 * (`~/.agentbox/mounts/<box-name>/`) and reveal in Finder. Docker boxes ride
 * their always-on localhost sshd (the alias is already in `~/.ssh/config` from
 * create/start); cloud boxes reuse the SSH alias `agentbox code` manages
 * (Daytona maps it to a fresh 60-min token per call).
 */
async function runSshfsMount(box: BoxRecord, opts: OpenOpts): Promise<void> {
  const mountRoot = join(homedir(), '.agentbox', 'mounts', box.name);

  // `--unmount` is handled up front in the action (provider-independent).

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
      'sshfs not found on PATH. Install with `brew install macfuse sshfs` (macOS) or your distro\'s package manager, then retry. `agentbox open` mounts the box /workspace via sshfs.',
    );
  }

  let alias: string;
  if ((box.provider ?? 'docker') === 'docker') {
    // Docker: bring the box online so sshd is up + the loopback port is fresh,
    // then rely on the alias already written to `~/.ssh/config` by create/start.
    let online = await bringDockerBoxOnline(box);
    if (!online.ssh) online = await resolveBoxOrExit(online.id);
    if (!online.ssh) {
      throw new Error(
        `box '${box.name}' has no SSH endpoint — its in-box sshd may have failed to start. ` +
          `Try 'agentbox start ${box.name}' and retry, or 'agentbox open ${box.name} --in vscode'.`,
      );
    }
    await syncAgentboxSshConfig();
    alias = agentboxAliasFor(online.name);
  } else {
    // Same SSH alias machinery `agentbox code` uses — bring the box online and
    // (re)write the alias (a fresh 60-min token for Daytona) so sshfs gets a
    // live mount target.
    const provider = await providerForBox(box);
    ({ alias } = await ensureCloudSshAlias(box, provider));
  }

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
    const err = `${mount.stderr || ''}${mount.stdout || ''}`;
    // sshfs is on PATH but the mount failed — on macOS the usual cause is a
    // missing/unapproved macFUSE kernel extension (sshfs is built against it).
    const macfuseHint =
      process.platform === 'darwin' && /fuse|macfuse|load|not permitted|mount_macfuse/i.test(err)
        ? ` — is macFUSE installed and approved? Run 'brew install macfuse' (may need a reboot and ` +
          `approving the system extension in System Settings › Privacy & Security), then retry.`
        : '';
    throw new Error(`sshfs mount failed (exit ${String(mount.exitCode)}): ${err}${macfuseHint}`);
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

