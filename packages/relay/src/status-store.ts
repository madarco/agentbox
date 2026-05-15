import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A box status snapshot as received from the in-box daemon. The relay treats
 * it structurally (it has no dep on `@agentbox/ctl`); the rich type lives in
 * `@agentbox/ctl` (`BoxStatus`) and is what the host CLI parses back.
 */
export type BoxStatusSnapshot = Record<string, unknown>;

/** Mirrors `boxRunDirFor` in @agentbox/sandbox-docker — kept in sync by hand. */
function boxStatusPathFor(boxId: string): string {
  return join(homedir(), '.agentbox', 'boxes', boxId, 'status.json');
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

  /** Update the in-memory entry and best-effort persist it to disk. */
  async set(boxId: string, status: BoxStatusSnapshot): Promise<void> {
    this.map.set(boxId, status);
    const target = boxStatusPathFor(boxId);
    const tmp = `${target}.${String(process.pid)}.tmp`;
    try {
      await mkdir(join(homedir(), '.agentbox', 'boxes', boxId), { recursive: true });
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
