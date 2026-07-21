/**
 * Concern: skills — the shared `~/.agents` tree (`~/.agents/skills/<name>`, the
 * cross-agent Agent Skills location) seeded host→box so the in-box agents see
 * the same skill set the host does.
 *
 * On docker this is a persistent shared volume seeded from the host via the
 * transport's `seedVolumeFromHost` (a throwaway rsync helper container). Cloud
 * has no helper container (`caps.helperContainer === false`) — its static config
 * is baked into the prepare-time snapshot via `stageAgentsStaticForUpload` — so
 * cloud never calls this.
 *
 * The host is authoritative and the sync is additive (no `--delete`). Skills
 * routinely symlink files into checkouts, so the seed dereferences reachable
 * links (`copyUnsafeLinks`) and excludes the ones the box can't resolve (broken
 * on the host or pointing outside the mounted tree — see `findUnsyncableSymlinks`),
 * or rsync aborts with "symlink has no referent".
 */

import { stat } from 'node:fs/promises';
import type { SyncTransport } from '@agentbox/core';
import { findUnsyncableSymlinks } from '../host-links.js';

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface SeedAgentsVolumeArgs {
  /** Transport bound to the box's provider. Must expose `seedVolumeFromHost`. */
  transport: SyncTransport;
  /** The shared agents-config volume name (already ensured to exist). */
  volume: string;
  /** Host `~/.agents` dir. */
  hostAgents: string;
  /**
   * Sync host → volume when true AND the host `~/.agents` exists. When false or
   * absent, the volume is only made writable by the in-box `vscode` user.
   */
  syncFromHost: boolean;
  onLog?: (line: string) => void;
}

export interface SeedAgentsVolumeResult {
  /** True when the rsync helper ran (syncFromHost was true AND host had `~/.agents`). */
  synced: boolean;
}

/**
 * Seed (or make writable) the shared `~/.agents` volume via the transport's
 * persistent-volume seam. The caller owns volume creation + `created`
 * detection; this owns the host→volume sync decision so both providers (only
 * docker today) share it.
 */
export async function seedAgentsVolume(args: SeedAgentsVolumeArgs): Promise<SeedAgentsVolumeResult> {
  const seed = args.transport.seedVolumeFromHost;
  if (!seed) throw new Error('seedAgentsVolume requires a transport with seedVolumeFromHost');

  const willSync = args.syncFromHost && (await pathExists(args.hostAgents));
  if (!willSync) {
    // No host ~/.agents to sync — an empty source set still makes the (possibly
    // freshly created, root-owned) volume root writable by the in-box vscode
    // user. Best-effort: a failed chown must not abort box creation (the sync
    // path below, by contrast, propagates — a botched skills sync is worth
    // surfacing).
    try {
      await seed.call(args.transport, args.volume, []);
    } catch (err) {
      args.onLog?.(
        `skills: volume writable-chown failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { synced: false };
  }

  // `--copy-unsafe-links` dereferences a skill's symlinks pointing outside
  // ~/.agents into real files; the ones it can't resolve (broken / out-of-tree)
  // are excluded so the sync doesn't abort with "symlink has no referent".
  const excludes = (await findUnsyncableSymlinks(args.hostAgents, [args.hostAgents])).map(
    (rel) => `/${rel}`,
  );
  await seed.call(args.transport, args.volume, [
    { hostDir: args.hostAgents, destSubpath: '', exclude: excludes, copyUnsafeLinks: true },
  ]);
  if (excludes.length > 0) {
    args.onLog?.(`skills: excluded ${String(excludes.length)} unsyncable symlink(s) from ~/.agents`);
  }
  return { synced: true };
}
