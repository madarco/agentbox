import { log } from '@clack/prompts';
import { execa } from 'execa';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BoxRecord } from '@agentbox/core';
import { hostOpenCommand, ensureCloudSshAlias } from '@agentbox/sandbox-core';
import { openBoxInFinder } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import { runPath } from './path.js';
import { handleLifecycleError } from './_errors.js';

interface OpenOpts {
  refresh: boolean; // commander gives `--no-refresh` => refresh=false
  includeNodeModules?: boolean;
  print?: boolean;
  path?: boolean;
  unmount?: boolean;
}

export const openCommand = new Command('open')
  .description("Open a box's /workspace in Finder (docker: rsync'd snapshot; cloud: sshfs mount)")
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
  .action(async (idOrName: string | undefined, opts: OpenOpts) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
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

