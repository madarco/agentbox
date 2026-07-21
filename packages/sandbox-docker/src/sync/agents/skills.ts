import { homedir } from 'node:os';
import { join } from 'node:path';
import { seedAgentsVolume } from '@agentbox/sandbox-core';
import { ensureVolume, volumeExists } from '../../docker.js';
import { createDockerSyncTransport } from '../sync-transport.js';

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

  // The host→volume rsync (symlink handling, `--copy-unsafe-links`, the
  // no-host-dir writable-chown fallback) is the shared skills concern, driven
  // through the transport's throwaway rsync-helper container. `container: ''`
  // because the seed needs only the helper image, not a running box.
  const transport = createDockerSyncTransport({ container: '', image: opts.image });
  const { synced } = await seedAgentsVolume({
    transport,
    volume: spec.volume,
    hostAgents: join(homedir(), '.agents'),
    syncFromHost: opts.syncFromHost,
  });
  return { created, synced };
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
