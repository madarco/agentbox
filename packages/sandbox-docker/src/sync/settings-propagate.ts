/**
 * Docker implementations of the settings-propagate seams
 * (`@agentbox/sandbox-core` `agent-propagate.ts`): stage items *from* a config
 * volume and write items *into* a config volume, both via throwaway helper
 * containers so they work regardless of any box's run state (a shared-volume
 * write covers every docker box on that volume, running or paused).
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import type { SettingsTarget, StagedItem } from '@agentbox/sandbox-core';

const posixDirname = (rel: string) => {
  const d = dirname(rel);
  return d === '.' ? '' : d;
};

/**
 * Copy `items` from a config volume into `stagingDir` (volume-style layout).
 * One helper-container run; `rsync --exclude=node_modules` for dirs (the box
 * carries platform binaries useless off-box), `cp -a` for files. Staged files
 * are chowned to the host user so the CLI can read/push them.
 */
export async function stageItemsFromVolume(
  volume: string,
  image: string,
  items: StagedItem[],
  stagingDir: string,
): Promise<void> {
  if (items.length === 0) return;
  for (const item of items) {
    const parent = posixDirname(item.rel);
    if (parent) await mkdir(join(stagingDir, parent), { recursive: true });
  }
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const cmds = items.map((item) =>
    item.kind === 'dir'
      ? `mkdir -p '/stage/${item.rel}' && rsync -a --exclude=node_modules '/src/${item.rel}/' '/stage/${item.rel}/'`
      : `cp -a '/src/${item.rel}' '/stage/${item.rel}'`,
  );
  cmds.push(`chown -R ${String(uid)}:${String(gid)} /stage`);
  const r = await execa(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${volume}:/src:ro`,
      '-v',
      `${stagingDir}:/stage`,
      image,
      'sh',
      '-c',
      cmds.join(' && '),
    ],
    { reject: false },
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `failed to stage items from volume ${volume}: ${(r.stderr ?? '').toString().trim() || `exit ${String(r.exitCode)}`}`,
    );
  }
}

/**
 * A `SettingsTarget` over a docker config volume. Every op is a helper
 * container; writes chown to the in-box uid 1000 (`vscode` in the box image).
 */
export function volumeSettingsTarget(volume: string, image: string, label: string): SettingsTarget {
  const run = (args: string[], input?: string) =>
    execa('docker', args, { reject: false, ...(input === undefined ? {} : { input }) });
  return {
    label,
    async exists(rel: string): Promise<boolean> {
      const r = await run(['run', '--rm', '-v', `${volume}:/dst:ro`, image, 'test', '-e', `/dst/${rel}`]);
      return r.exitCode === 0;
    },
    async readText(rel: string): Promise<string | null> {
      const r = await run([
        'run',
        '--rm',
        '--user',
        '0',
        '-v',
        `${volume}:/dst:ro`,
        image,
        'cat',
        `/dst/${rel}`,
      ]);
      return r.exitCode === 0 ? String(r.stdout ?? '') : null;
    },
    async writeText(rel: string, content: string, opts?: { mode?: number }): Promise<void> {
      const parent = posixDirname(rel);
      const chmod = opts?.mode !== undefined ? ` && chmod ${opts.mode.toString(8)} '/dst/${rel}'` : '';
      const r = await run(
        [
          'run',
          '--rm',
          '-i',
          '--user',
          '0',
          '-v',
          `${volume}:/dst`,
          image,
          'sh',
          '-c',
          `${parent ? `mkdir -p '/dst/${parent}' && ` : ''}cat > '/dst/${rel}' && chown 1000:1000 '/dst/${rel}'${chmod}`,
        ],
        content,
      );
      if (r.exitCode !== 0) {
        throw new Error(
          `failed to write ${rel} into volume ${volume}: ${(r.stderr ?? '').toString().trim() || `exit ${String(r.exitCode)}`}`,
        );
      }
    },
    async copyIn(stagingAbs: string, rel: string, kind: 'dir' | 'file'): Promise<void> {
      const parent = posixDirname(rel);
      const script =
        `${parent ? `mkdir -p '/dst/${parent}' && ` : ''}` +
        (kind === 'dir'
          ? `mkdir -p '/dst/${rel}' && rsync -a --ignore-existing '/stage-item/' '/dst/${rel}/'`
          : `cp -a /stage-item '/dst/${rel}'`) +
        ` && chown -R 1000:1000 '/dst/${rel}'`;
      const r = await run([
        'run',
        '--rm',
        '--user',
        '0',
        '-v',
        `${stagingAbs}:/stage-item:ro`,
        '-v',
        `${volume}:/dst`,
        image,
        'sh',
        '-c',
        script,
      ]);
      if (r.exitCode !== 0) {
        throw new Error(
          `failed to copy ${rel} into volume ${volume}: ${(r.stderr ?? '').toString().trim() || `exit ${String(r.exitCode)}`}`,
        );
      }
    },
  };
}
