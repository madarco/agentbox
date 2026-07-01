import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { findUnsyncableSymlinks } from './claude.js';
import { ensureVolume, volumeExists } from './docker.js';

/**
 * The shared `~/.agents` directory — the cross-agent "Agent Skills" location
 * (`~/.agents/skills/<name>`, managed by the open skills installer). Codex
 * discovers skills from here directly (not just `~/.codex/skills`), and the
 * per-agent `~/.codex/skills/<x>` symlinks point back into it
 * (`../../.agents/skills/<x>`). We mount it into the box so the in-box agents
 * see the same skill set the host does.
 *
 * Unlike claude/codex this holds no auth — it's skills only — but it's synced
 * the same host-authoritative way and shares one volume across boxes.
 */
export const SHARED_AGENTS_VOLUME = 'agentbox-agents-config';

/** Where the agents volume is mounted in the box. */
const CONTAINER_AGENTS_DIR = '/home/vscode/.agents';

export interface AgentsConfigSpec {
  /** Resolved Docker volume name mounted at /home/vscode/.agents. */
  volume: string;
}

/** Always the shared volume — `~/.agents` is skills-only, so per-box isolation
 *  buys nothing (no auth to keep separate). */
export function resolveAgentsVolume(): AgentsConfigSpec {
  return { volume: SHARED_AGENTS_VOLUME };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface EnsureAgentsVolumeOptions {
  /**
   * When true and the host's ~/.agents exists, rsync host -> volume on every
   * call. Additive (no `--delete`): host files win on overlap.
   */
  syncFromHost: boolean;
  /** Image used by the throwaway sync helper container (the box image). */
  image: string;
}

export interface EnsureAgentsVolumeResult {
  /** True only the very first time the volume is created (on this host). */
  created: boolean;
  /** True when the rsync helper ran (syncFromHost was true AND host ~/.agents existed). */
  synced: boolean;
}

/**
 * Ensure the agents-config volume exists, then (when {@link
 * EnsureAgentsVolumeOptions.syncFromHost} is true and the host has a `~/.agents`)
 * rsync host -> volume via a throwaway helper container. Mirrors
 * {@link import('./codex.js').ensureCodexVolume}.
 *
 * `--copy-unsafe-links` dereferences a skill's symlinks that point outside
 * `~/.agents` into real files in the volume; broken / out-of-tree symlinks are
 * `--exclude`d (via {@link findUnsyncableSymlinks}) so the sync can't abort with
 * "symlink has no referent".
 */
export async function ensureAgentsVolume(
  spec: AgentsConfigSpec,
  opts: EnsureAgentsVolumeOptions,
): Promise<EnsureAgentsVolumeResult> {
  const existed = await volumeExists(spec.volume);
  await ensureVolume(spec.volume);
  const created = !existed;

  const hostAgents = join(homedir(), '.agents');
  const willSync = opts.syncFromHost && (await pathExists(hostAgents));
  if (willSync) {
    const unsyncable = await findUnsyncableSymlinks(hostAgents, [hostAgents]);
    const symlinkExcludes = unsyncable.map((rel) => ` --exclude=/${rel}`).join('');
    await execa('docker', [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${spec.volume}:/dst`,
      '-v',
      `${hostAgents}:/src:ro`,
      opts.image,
      'sh',
      '-c',
      'rsync -a --copy-unsafe-links' + symlinkExcludes + ' /src/ /dst/ && chown -R 1000:1000 /dst',
    ]);
    return { created, synced: true };
  }

  // No host ~/.agents to sync — still make the (possibly freshly created,
  // root-owned) volume root writable by the in-box `vscode` user.
  await execa(
    'docker',
    ['run', '--rm', '--user', '0', '-v', `${spec.volume}:/dst`, opts.image, 'sh', '-c', 'chown 1000:1000 /dst'],
    { reject: false },
  );
  return { created, synced: false };
}

export interface AgentsMountResult {
  /** Docker -v spec strings to append to runBox(extraVolumes). */
  extraVolumes: string[];
  /** The resolved volume name (for BoxRecord). */
  volumeName: string;
}

export function buildAgentsMounts(spec: AgentsConfigSpec): AgentsMountResult {
  return {
    extraVolumes: [`${spec.volume}:${CONTAINER_AGENTS_DIR}`],
    volumeName: spec.volume,
  };
}
