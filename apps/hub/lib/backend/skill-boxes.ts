// Skills on running boxes (docs/hub-skills-plan.md, Phase 5): which version of
// each library skill a box holds, whether it is `behind`, and the `skills.sync`
// that brings it level.
//
// What a box holds is the set the relay last served it on `skills.get`, recorded
// in custody at `boxes/<boxId>/skills.json` (`recordServed` in
// packages/relay/src/skills-rpc.ts — the layout is duplicated here, as the meta
// reader is there, because Next routes can't import the relay).
//
// The sync is `agentbox-ctl skills sync` over `Provider.exec`, the same
// cross-provider path the destroy-time history flush uses: docker exec for
// docker, the provider's SDK or SSH for every cloud provider and remote-docker.
// The box then pulls over its own relay channel. A box that isn't running is
// never woken; ctl runs the same pull at its next boot.
import { readMeta, type SkillsStore } from './skills';

export const SKILLS_SYNC_TIMEOUT_MS = 120_000;
/** Boxes synced at once by a fan-out. */
const SYNC_CONCURRENCY = 4;

export function boxSkillsRecordPath(boxId: string): string {
  return `boxes/${boxId}/skills.json`;
}

export interface BoxSkillState {
  name: string;
  /** The version the box was served last. */
  version: string;
  /** The library's current version; absent when the skill was discarded. */
  current?: string;
  /** A pending (unapproved) version exists for the skill. */
  pending?: string;
  /** The box holds something other than current. */
  behind: boolean;
}

export interface BoxSkillsStatus {
  boxId: string;
  /** When the box's served set last changed; absent = it never pulled from this hub. */
  recordedAt?: string;
  skills: BoxSkillState[];
}

async function readRecord(
  store: SkillsStore,
  boxId: string,
): Promise<{ at: string; skills: Record<string, string> } | null> {
  const found = await store.get(boxSkillsRecordPath(boxId)).catch(() => null);
  if (!found) return null;
  try {
    const r = JSON.parse(found.data.toString('utf8')) as { at?: unknown; skills?: unknown };
    if (!r.skills || typeof r.skills !== 'object') return null;
    const skills: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.skills as Record<string, unknown>)) {
      if (typeof v === 'string') skills[k] = v;
    }
    return { at: typeof r.at === 'string' ? r.at : '', skills };
  } catch {
    return null;
  }
}

export async function boxSkillsStatus(store: SkillsStore, boxId: string): Promise<BoxSkillsStatus> {
  const rec = await readRecord(store, boxId);
  if (!rec) return { boxId, skills: [] };
  const skills: BoxSkillState[] = [];
  for (const name of Object.keys(rec.skills).sort()) {
    const version = rec.skills[name]!;
    const meta = await readMeta(store, name).catch(() => null);
    skills.push({
      name,
      version,
      ...(meta ? { current: meta.current } : {}),
      ...(meta?.pending ? { pending: meta.pending } : {}),
      // A discarded skill is removed by the next sync, so it counts as behind.
      behind: !meta || meta.current !== version,
    });
  }
  return { boxId, ...(rec.at ? { recordedAt: rec.at } : {}), skills };
}

export interface SkillBoxesDeps {
  store: SkillsStore;
  /** Ids of every box this hub can reach (local records and registrations). */
  boxIds(): Promise<string[]>;
  /** The provider's state probe for a box (`running`, `paused`, ...). */
  probeState(boxId: string): Promise<string>;
  exec(
    boxId: string,
    argv: string[],
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  log(line: string): void;
  timeoutMs?: number;
}

export interface SkillSyncOutcome {
  boxId: string;
  status: 'synced' | 'failed' | 'not-running';
  detail?: string;
}

/**
 * Sync boxes. `boxIds` names them (an explicit "update this box"); otherwise
 * every box whose recorded set is behind on one of `names` (any skill when
 * `names` is absent) is synced. Never throws.
 */
export async function syncSkillBoxes(
  deps: SkillBoxesDeps,
  opts: { boxIds?: string[]; names?: string[] } = {},
): Promise<SkillSyncOutcome[]> {
  let targets: string[];
  const explicit = opts.boxIds !== undefined;
  if (explicit) {
    targets = opts.boxIds!;
  } else {
    const ids = await deps.boxIds().catch(() => [] as string[]);
    const want = opts.names ? new Set(opts.names) : null;
    targets = [];
    for (const id of ids) {
      const st = await boxSkillsStatus(deps.store, id).catch(() => null);
      if (st?.skills.some((s) => s.behind && (!want || want.has(s.name)))) targets.push(id);
    }
  }
  const out: SkillSyncOutcome[] = [];
  const queue = [...targets];
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      out.push(await syncOne(deps, id));
    }
  };
  await Promise.all(Array.from({ length: Math.min(SYNC_CONCURRENCY, queue.length) }, worker));
  return out.sort((a, b) => a.boxId.localeCompare(b.boxId));
}

async function syncOne(deps: SkillBoxesDeps, boxId: string): Promise<SkillSyncOutcome> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const state = await deps.probeState(boxId);
    if (state !== 'running') {
      return { boxId, status: 'not-running', detail: `${state}; syncs at its next start` };
    }
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('timed out')),
        deps.timeoutMs ?? SKILLS_SYNC_TIMEOUT_MS,
      );
    });
    const r = await Promise.race([deps.exec(boxId, ['agentbox-ctl', 'skills', 'sync']), timeout]);
    const line = (r.stdout.trim().split('\n').pop() ?? '').slice(0, 300);
    if (r.exitCode !== 0) {
      const why = (r.stderr.trim().split('\n').pop() ?? '').slice(0, 300);
      deps.log(`skills: sync of ${boxId} exited ${String(r.exitCode)}: ${why}`);
      return { boxId, status: 'failed', detail: why || line || `exit ${String(r.exitCode)}` };
    }
    return { boxId, status: 'synced', ...(line ? { detail: line } : {}) };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    deps.log(`skills: sync of ${boxId} failed: ${why}`);
    return { boxId, status: 'failed', detail: why };
  } finally {
    clearTimeout(timer);
  }
}
