/**
 * Read-only status helpers for `agentbox prepare` (no-args mode). Surfaces
 * the user-facing inventory of agentbox-owned base images / snapshots /
 * volumes on the configured Daytona org so the user can see at a glance
 * what's already prepared and what isn't.
 *
 * Daytona-side state lives in two places:
 *   - **Snapshots** — built by `agentbox prepare --provider daytona`. Listed
 *     filtered to `agentbox*` so we don't surface unrelated org snapshots.
 *   - **Volumes** — the per-org `agentbox-credentials` volume created lazily
 *     by `ensureAgentVolumesForCloud` on first `agentbox create --provider
 *     daytona`.
 *
 * All calls swallow auth/network errors and return an empty section — the
 * status command must work for users who don't have Daytona configured.
 */

import { ensureDaytonaEnvLoaded } from './env-loader.js';
import { getClient } from './backend.js';

export interface DaytonaSnapshotSummary {
  name: string;
  state?: string;
  /** Snapshot size in GB, as reported by Daytona (may be undefined for non-`active` states). */
  sizeGb?: number;
  createdAt?: string;
  errorReason?: string;
}

export interface DaytonaVolumeSummary {
  name: string;
  id: string;
  state?: string;
  createdAt?: string;
  lastUsedAt?: string;
}

export interface DaytonaStatus {
  /** True when Daytona credentials are present + the SDK could connect. */
  configured: boolean;
  /** Snapshots whose name starts with `agentbox` (case-insensitive). */
  snapshots: DaytonaSnapshotSummary[];
  /** Volumes whose name starts with `agentbox` (case-insensitive). */
  volumes: DaytonaVolumeSummary[];
  /** Non-fatal explanation when `configured` is false. */
  reason?: string;
}

function isAgentboxName(name: unknown): boolean {
  return typeof name === 'string' && name.toLowerCase().startsWith('agentbox');
}

/**
 * Upper bound on a status list call. This is a *diagnostic* read — a hung API
 * must degrade to "couldn't list" rather than stall the caller. `doctor` in
 * particular prints no spinner, so an unbounded await just looks like a freeze.
 * Mirrors the bound the cloud-state probes already use host-side.
 */
const STATUS_PROBE_TIMEOUT_MS = 8000;

function withStatusTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${what} timed out after ${String(STATUS_PROBE_TIMEOUT_MS)}ms`)),
      STATUS_PROBE_TIMEOUT_MS,
    );
    // The SDK call keeps running; we just stop waiting on it. unref so a pending
    // timer can't hold the process open after the CLI is done.
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Are Daytona credentials present? Credential-only: constructs the SDK client
 * (which throws when no key/JWT is configured) and makes **no network call**.
 *
 * This is what `configured` in {@link DaytonaStatus} has always meant — the
 * status helper sets it as soon as the client is built, before any list. Callers
 * that only want that answer (the install wizard's provider picker, doctor's
 * "credentials" row) should ask here rather than pay for two API round-trips.
 */
export function hasDaytonaCredentials(): { configured: boolean; reason?: string } {
  try {
    ensureDaytonaEnvLoaded();
    getClient();
    return { configured: true };
  } catch (err) {
    return {
      configured: false,
      reason: err instanceof Error ? err.message.split('\n')[0] : String(err),
    };
  }
}

export interface DaytonaStatusOptions {
  /**
   * Fetch the volume list. Each list is a separate round-trip to the Daytona
   * API, and `doctor` renders only the snapshot count — so it asks for snapshots
   * alone and halves the network cost of the check. `prepare --status`, which
   * prints the volume inventory, leaves this on. Default true (the full picture).
   */
  volumes?: boolean;
}

/**
 * Collect a read-only summary of agentbox-owned snapshots + volumes on the
 * Daytona org. Never throws — failure paths return `configured: false` with
 * a one-line reason.
 *
 * Only reaches the network when credentials are present: with no key `getClient()`
 * throws and we return `configured: false` before any request — so an unconfigured
 * machine pays nothing.
 */
export async function getDaytonaStatus(opts: DaytonaStatusOptions = {}): Promise<DaytonaStatus> {
  const wantVolumes = opts.volumes !== false;
  try {
    ensureDaytonaEnvLoaded();
  } catch (err) {
    return {
      configured: false,
      snapshots: [],
      volumes: [],
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  let client;
  try {
    client = getClient();
  } catch (err) {
    return {
      configured: false,
      snapshots: [],
      volumes: [],
      reason: err instanceof Error ? err.message.split('\n')[0] : String(err),
    };
  }

  const snapshots: DaytonaSnapshotSummary[] = [];
  const volumes: DaytonaVolumeSummary[] = [];
  const reasons: string[] = [];

  // Both lists are independent round-trips; issue them together rather than
  // back to back. Each is bounded — an unreachable/slow Daytona must degrade to
  // "couldn't list" rather than hang `doctor` (which has no spinner at all, so a
  // stall just looks like a freeze).
  const listSnapshots = async (): Promise<void> => {
    try {
      const list = await withStatusTimeout(client.snapshot.list(), 'snapshot list');
      const items = (list as { items?: unknown[] }).items ?? (Array.isArray(list) ? list : []);
      for (const s of items) {
        const dto = s as { name?: unknown; state?: unknown; size?: unknown; createdAt?: unknown; errorReason?: unknown };
        if (!isAgentboxName(dto.name)) continue;
        snapshots.push({
          name: dto.name as string,
          state: typeof dto.state === 'string' ? dto.state : undefined,
          sizeGb: typeof dto.size === 'number' ? dto.size : undefined,
          createdAt: typeof dto.createdAt === 'string' ? dto.createdAt : undefined,
          errorReason: typeof dto.errorReason === 'string' ? dto.errorReason : undefined,
        });
      }
    } catch (err) {
      reasons.push(
        `snapshot list failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
      );
    }
  };

  const listVolumes = async (): Promise<void> => {
    try {
      const list = await withStatusTimeout(client.volume.list(), 'volume list');
      const items: unknown[] = Array.isArray(list)
        ? list
        : ((list as { items?: unknown[] }).items ?? []);
      for (const v of items) {
        const dto = v as { name?: unknown; id?: unknown; state?: unknown; createdAt?: unknown; lastUsedAt?: unknown };
        if (!isAgentboxName(dto.name)) continue;
        volumes.push({
          name: dto.name as string,
          id: typeof dto.id === 'string' ? dto.id : '',
          state: typeof dto.state === 'string' ? dto.state : undefined,
          createdAt: typeof dto.createdAt === 'string' ? dto.createdAt : undefined,
          lastUsedAt: typeof dto.lastUsedAt === 'string' ? dto.lastUsedAt : undefined,
        });
      }
    } catch (err) {
      reasons.push(
        `volume list failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
      );
    }
  };

  await Promise.all(wantVolumes ? [listSnapshots(), listVolumes()] : [listSnapshots()]);
  const reason = reasons.length > 0 ? reasons.join('; ') : undefined;

  return {
    configured: true,
    snapshots: snapshots.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
    volumes: volumes.sort((a, b) => a.name.localeCompare(b.name)),
    reason,
  };
}
