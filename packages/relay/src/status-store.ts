import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A box status snapshot as received from the in-box daemon. The relay treats
 * it structurally (it has no dep on `@agentbox/ctl`); the rich type lives in
 * `@agentbox/ctl` (`BoxStatus`) and is what the host CLI parses back.
 */
export type BoxStatusSnapshot = Record<string, unknown>;

/**
 * Mirrors `sanitizeMnemonic` in @agentbox/config — duplicated here so the relay
 * stays dep-free. Two source-of-truth files; the schema-drift-style guarantee
 * is that boxes only land in `<id>-<mnemonic>/` if both impls agree.
 */
function sanitizeMnemonic(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/-/g, '_')
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'unnamed'
  );
}

/**
 * Mirrors `boxRunDirFor` / `boxDirSegment` in @agentbox/sandbox-docker — kept
 * in sync by hand. When `projectIndex` (`agentbox list`'s `N`) is set the
 * segment is `<id>-<n>-<mnemonic>` so directories sort cleanly within a
 * project; legacy (pre-feature) boxes register without it and fall back to
 * the original `<id>-<mnemonic>` shape.
 */
function boxRunDirFor(boxId: string, name: string, projectIndex?: number): string {
  const mnemonic = sanitizeMnemonic(name);
  const segment =
    typeof projectIndex === 'number' && Number.isFinite(projectIndex) && projectIndex > 0
      ? `${boxId}-${String(projectIndex)}-${mnemonic}`
      : `${boxId}-${mnemonic}`;
  return join(homedir(), '.agentbox', 'boxes', segment);
}

function boxStatusPathFor(boxId: string, name: string, projectIndex?: number): string {
  return join(boxRunDirFor(boxId, name, projectIndex), 'status.json');
}

/**
 * Structural guard: a valid box-status payload is an object with `schema === 1`
 * and a non-empty `boxId` string. The relay persists it verbatim; the host
 * reader does the strict typing.
 */
export function isValidBoxStatus(payload: unknown): payload is BoxStatusSnapshot {
  if (typeof payload !== 'object' || payload === null) return false;
  const o = payload as Record<string, unknown>;
  return o.schema === 1 && typeof o.boxId === 'string' && o.boxId.length > 0;
}

/**
 * In-memory latest-status map plus a durable per-box file at
 * `~/.agentbox/boxes/<id>/status.json`. The relay is a single process so it is
 * the single writer; the atomic tmp+rename means the host CLI never reads a
 * torn file. The on-disk copy is what makes status survive box pause/stop,
 * relay restart, and host reboot.
 */
export class BoxStatusStore {
  private readonly map = new Map<string, BoxStatusSnapshot>();

  get(boxId: string): BoxStatusSnapshot | undefined {
    return this.map.get(boxId);
  }

  /**
   * Update the in-memory entry and best-effort persist it to disk. `name` is
   * the box's user-facing name (from the registry); `projectIndex` is the
   * 1-based per-project `N`. Together they form the on-disk dir
   * `~/.agentbox/boxes/<id>-<n>-<mnemonic>/status.json` (or
   * `<id>-<mnemonic>/` if N is absent — legacy boxes).
   */
  async set(
    boxId: string,
    name: string,
    projectIndex: number | undefined,
    status: BoxStatusSnapshot,
  ): Promise<void> {
    this.map.set(boxId, status);
    const target = boxStatusPathFor(boxId, name, projectIndex);
    const tmp = `${target}.${String(process.pid)}.tmp`;
    try {
      await mkdir(boxRunDirFor(boxId, name, projectIndex), { recursive: true });
      await writeFile(tmp, JSON.stringify(status), 'utf8');
      await rename(tmp, target);
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  /** Drop the in-memory entry (the on-disk file is wiped with the box dir). */
  delete(boxId: string): void {
    this.map.delete(boxId);
  }
}
