// A workspace timeline as a branch graph. Each box is a lane that forks off the
// trunk (or off another box's branch) and merges back into its pull request's
// base; a pull request no box is known to own gets a lane for its head branch;
// everything else is on the trunk. Pure, and run over the whole aggregated log
// before paging, so a lane whose fork is on an older page keeps its id.
import type { TimelineBoxFact } from './deps';
import type { TimelineItem, TimelineLane, TimelineLiveItem } from '../boxes/backend-types';

export const TRUNK = 'trunk';

const JOB_KEY = /^job:(.+):(?:created|ready|failed)$/u;

/** Lifecycle rows say nothing about whether a lane's work is finished. */
const LIFECYCLE = new Set(['box.started', 'box.stopped']);

type Row = TimelineItem | TimelineLiveItem;

function kindOf(id: string): TimelineLane['kind'] {
  if (id.startsWith('box:')) return 'box';
  return id.startsWith('branch:') ? 'branch' : 'trunk';
}

function branchOf(row: Row): string | undefined {
  return row.pr?.head || row.branch || undefined;
}

/** The create job a row's dedupe key names, if it names one. */
export function jobIdOfKey(key: string | undefined): string | undefined {
  return key ? JOB_KEY.exec(key)?.[1] : undefined;
}

function jobOf(row: Row): string | undefined {
  return 'key' in row ? jobIdOfKey(row.key) : undefined;
}

function oldestFirst(a: { at: string; id: string }, b: { at: string; id: string }): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Stamps `lane` on every item and live row, in place. */
export function assignLanes(
  items: TimelineItem[],
  live: TimelineLiveItem[],
  boxes: TimelineBoxFact[],
): void {
  const asc = [...items].sort(oldestFirst);

  // `box.created` is written at queue time, before the box has an id; its job's
  // `box.ready`/`box.failed` carries both.
  const boxOfJob = new Map<string, string>();
  for (const item of items) {
    const job = item.boxId ? jobOf(item) : undefined;
    if (job) boxOfJob.set(job, item.boxId!);
  }
  const boxLaneOf = (row: Row): string | undefined => {
    const job = jobOf(row);
    const boxId = row.boxId ?? (job ? boxOfJob.get(job) : undefined);
    return boxId ? `box:${boxId}` : undefined;
  };

  const baseOf = new Map<string, string>();
  for (const item of asc) {
    const lane = item.base && item.type !== 'box.branch' ? boxLaneOf(item) : undefined;
    if (lane && !baseOf.has(lane)) baseOf.set(lane, item.base!);
  }

  // The trunk's branches (`main`): every fork or merge base that is not some
  // box's own branch. Known before the walk, so a box that checks one out never
  // carries it, or every later fork and merge would hang off that box.
  const boxBranches = new Set<string>();
  for (const item of items) {
    if ((item.type === 'box.created' || item.type === 'box.ready') && item.branch) {
      boxBranches.add(item.branch);
    }
  }
  const trunkBranches = new Set<string>();
  for (const item of items) {
    for (const base of [item.type === 'box.branch' ? undefined : item.base, item.pr?.base]) {
      if (base && !boxBranches.has(base)) trunkBranches.add(base);
    }
  }

  /** Branch → the lane that last carried it; never a trunk branch. */
  const carrier = new Map<string, string>();
  /** Lane → its current branch label; a lane is known once it has a row. */
  const labels = new Map<string, string | undefined>();

  const carrierOf = (branch: string | undefined): string | undefined =>
    branch && !trunkBranches.has(branch) ? carrier.get(branch) : undefined;
  const laneOn = (branch: string | undefined, self: string): string => {
    const lane = carrierOf(branch);
    return lane && lane !== self && lane.startsWith('box:') ? lane : TRUNK;
  };
  const laneIdOf = (row: Row): string => {
    const box = boxLaneOf(row);
    if (box) return box;
    const isPr = row.type.startsWith('pr.');
    if (isPr || row.type === 'git.push') {
      const head = branchOf(row);
      const carried = head ? carrier.get(head) : undefined;
      if (carried) return carried;
      if (isPr && row.pr?.head) return `branch:${row.pr.head}`;
    }
    return TRUNK;
  };
  const stamp = (row: Row, extra: Partial<TimelineLane> = {}): TimelineLane => {
    const id = laneIdOf(row);
    const lane: TimelineLane = { id, kind: kindOf(id), ...extra };
    if (id === TRUNK) return lane;
    if (!labels.has(id)) lane.from = laneOn(baseOf.get(id) ?? row.pr?.base, id);
    const branch = branchOf(row);
    if (branch && branch !== labels.get(id)) lane.branch = branch;
    labels.set(id, branch ?? labels.get(id));
    // A PR merged back into the lane's own earlier branch never leaves the lane.
    if (row.type === 'pr.merged' && carrierOf(row.pr?.base) !== id) {
      lane.into = laneOn(row.pr?.base, id);
    }
    if (branch && !trunkBranches.has(branch)) carrier.set(branch, id);
    return lane;
  };

  const newest = new Map<string, TimelineItem>();
  const lastWork = new Map<string, TimelineItem>();
  for (const item of asc) {
    item.lane = stamp(item);
    newest.set(item.lane.id, item);
    if (!LIFECYCLE.has(item.type)) lastWork.set(item.lane.id, item);
  }

  const liveLanes = new Set<string>();
  for (const row of live) {
    row.lane = stamp(row);
    if (row.lane.id === TRUNK) continue;
    row.lane.open = true;
    liveLanes.add(row.lane.id);
  }

  const facts = new Map(boxes.map((b) => [b.id, b]));
  for (const [id, item] of newest) {
    if (id === TRUNK) continue;
    if (liveLanes.has(id)) {
      item.lane!.open = true;
      continue;
    }
    const fact = id.startsWith('box:') ? facts.get(id.slice('box:'.length)) : undefined;
    if (!fact || item.type === 'box.destroyed') continue;
    // A box that is not running still holds its unfinished work; once its last
    // work was a merge or a close, its lane ends there.
    const done = lastWork.get(id)?.type;
    if (fact.state === 'running' || (done !== 'pr.merged' && done !== 'pr.closed')) {
      item.lane!.open = true;
    }
  }
}
