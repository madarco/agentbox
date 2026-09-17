// The timeline domain: a workspace's append-only event log (`timeline.jsonl`,
// written by every mutation point), aggregated for reading, plus the rows that
// are only ever true NOW — a box working a task, a PR waiting to be merged —
// which are built at read time and never stored.
import {
  findManager,
  findWorkspaceContaining,
  parseShortstat,
  pushedRef,
  pushLineStat,
  readRefTip,
  listWorkspaces,
  readReconciledManagers,
  readReconciledTasks,
  readTasks,
  readTimeline,
  readWorkspace,
  recordTimelineEvent,
  sortTasksByOrder,
  stampFields,
  workspaceForPath,
  type TimelineEvent,
  type TimelineEventInput,
  type TimelinePr,
  type PushStatInput,
  type TimelineStamp,
  type WorkTask,
} from '@agentbox/relay';
import { inBackground } from './background';
import { reconcileContext, type BackendDeps, type DiffStat, type TimelineBoxFact } from './deps';
import { createGithubPrSync, type GithubPrSync } from './github-prs';
import { assignLanes, jobIdOfKey } from './timeline-lanes';
import type {
  HubBackend,
  TimelineBackend,
  TimelineItem,
  TimelineLiveItem,
  TimelineMeta,
  TimelineQuery,
  TimelineResponse,
  TimelineSummary,
} from '../boxes/backend-types';

/** A manager's task creates within this window, from one turn, read as one plan. */
export const PLAN_WINDOW_MS = 10 * 60 * 1000;
export const PLAN_MIN_TASKS = 3;
/** A move to `in_progress` this soon after an assignment is that assignment, not news. */
const ASSIGN_STATUS_WINDOW_MS = 60 * 1000;
const DIFF_CACHE_MS = 60 * 1000;
/** A box's diff that takes longer than this is left off the read that asked for it. */
const DIFF_TIMEOUT_MS = 3000;
export const TIMELINE_DEFAULT_LIMIT = 100;

function newestFirst(a: { at: string; id: string }, b: { at: string; id: string }): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function taskIdsOf(ev: TimelineEvent): string[] {
  if (ev.taskIds?.length) return ev.taskIds;
  return ev.task ? [ev.task.id] : [];
}

/**
 * Whether two PR refs are one PR. A ref whose repo is unknown (a message that
 * named only a number) matches only when a single repo in the log has that
 * number; in a workspace over several repos, `#12` alone names none of them.
 */
function prMatcher(
  events: TimelineEvent[],
): (a: TimelineEvent['pr'], b: TimelineEvent['pr']) => boolean {
  const repos = new Map<number, Set<string>>();
  for (const ev of events) {
    if (!ev.pr?.repo) continue;
    const set = repos.get(ev.pr.number) ?? new Set<string>();
    set.add(ev.pr.repo);
    repos.set(ev.pr.number, set);
  }
  return (a, b) => {
    if (!a || !b || a.number !== b.number) return false;
    if (a.repo && b.repo) return a.repo === b.repo;
    const known = a.repo || b.repo;
    const set = repos.get(a.number);
    return Boolean(known) && set?.size === 1 && set.has(known);
  };
}

/**
 * Events as a reader wants them, newest first:
 * - 3+ `task.created` from one manager turn within 10 minutes become one `plan`;
 * - a `task.status → in_progress` right after that task's assignment is dropped;
 * - a `pr.merged` preceded by a message about that PR is `approvedByYou`.
 */
export function aggregateTimeline(events: TimelineEvent[]): TimelineItem[] {
  const asc = [...events].sort(newestFirst).reverse();
  const samePr = prMatcher(events);
  const drop = new Set<string>();

  const groups: TimelineEvent[][] = [];
  const openGroup = new Map<string, TimelineEvent[]>();
  for (const ev of asc) {
    if (ev.type !== 'task.created' || !ev.managerId || ev.turn === undefined) continue;
    const key = `${ev.managerId}|${String(ev.turn)}`;
    const group = openGroup.get(key);
    if (group && Date.parse(ev.at) - Date.parse(group[0]!.at) <= PLAN_WINDOW_MS) {
      group.push(ev);
    } else {
      const fresh = [ev];
      openGroup.set(key, fresh);
      groups.push(fresh);
    }
  }
  const plans: TimelineItem[] = [];
  for (const group of groups) {
    if (group.length < PLAN_MIN_TASKS) continue;
    for (const ev of group) drop.add(ev.id);
    const first = group[0]!;
    const prompt = group.find((ev) => ev.prompt)?.prompt;
    const projects = new Set(group.map((ev) => ev.projectId));
    plans.push({
      id: first.id,
      at: first.at,
      type: 'plan',
      actor: first.actor,
      managerId: first.managerId!,
      turn: first.turn!,
      ...(prompt ? { prompt } : {}),
      ...(projects.size === 1 && first.projectId ? { projectId: first.projectId } : {}),
      taskIds: group.flatMap(taskIdsOf),
      count: group.length,
    });
  }

  const assignedAt = new Map<string, number>();
  for (const ev of asc) {
    if (ev.type === 'task.assigned') {
      for (const id of taskIdsOf(ev)) assignedAt.set(id, Date.parse(ev.at));
    } else if (ev.type === 'task.status' && ev.task?.to === 'in_progress') {
      const at = assignedAt.get(ev.task.id);
      if (at !== undefined && Date.parse(ev.at) - at <= ASSIGN_STATUS_WINDOW_MS) drop.add(ev.id);
    }
  }

  const messages = asc.filter((ev) => ev.type === 'manager.message' && ev.pr);
  const items: TimelineItem[] = [];
  for (const ev of asc) {
    if (drop.has(ev.id)) continue;
    if (ev.type === 'pr.merged' && messages.some((m) => samePr(m.pr, ev.pr) && m.at <= ev.at)) {
      items.push({ ...ev, approvedByYou: true });
    } else {
      items.push(ev);
    }
  }
  return [...items, ...plans].sort(newestFirst);
}

/** The boxes and create jobs one manager session owns, as the row filter needs them. */
export interface ManagerScope {
  id: string;
  boxIds: Set<string>;
  boxJobIds: Set<string>;
}

/**
 * Rows that record a session taking a box on. Only these attribute a box through the log: a
 * session's OTHER stamped rows can name someone else's box (a `task.assigned` onto it, a
 * `manager.message` about its PR), and claiming it from those would let one session swallow
 * another's whole lane.
 */
const BOX_CREATE_TYPES = new Set(['box.created', 'box.ready', 'box.failed']);

/**
 * The boxes a session owns. The manager record is the live answer, but reconciliation PRUNES a
 * destroyed box from `boxIds` and writes that prune back — so a box that finished its work would
 * drop out of its own session's history, which is the one place that history still matters. The
 * log is append-only and still names the boxes this session created, so it is the durable half.
 */
export function managerScope(
  managerId: string,
  rows: readonly (TimelineItem | TimelineLiveItem)[],
  rec?: { boxIds: string[]; boxJobIds: string[] },
): ManagerScope {
  const boxIds = new Set(rec?.boxIds ?? []);
  const boxJobIds = new Set(rec?.boxJobIds ?? []);
  for (const row of rows) {
    if (row.managerId !== managerId || !BOX_CREATE_TYPES.has(row.type)) continue;
    if (row.boxId) boxIds.add(row.boxId);
    const job = 'key' in row ? jobIdOfKey(row.key) : undefined;
    if (job) boxJobIds.add(job);
  }
  return { id: managerId, boxIds, boxJobIds };
}

/**
 * Whether a row is this manager session's. A row it stamped is unambiguous; a row on a box it
 * owns counts too, because most box, push and PR rows were never stamped — `managerId` is only
 * written when `managerIdForTarget` could resolve one as the row was recorded. The box LANE is
 * checked as well as `boxId`: a `git.push` or `pr.*` row reaches a box's lane through the branch
 * carrier without ever naming the box.
 */
export function rowBelongsToManager(
  row: TimelineItem | TimelineLiveItem,
  scope: ManagerScope,
): boolean {
  if (row.managerId === scope.id) return true;
  if (row.boxId && scope.boxIds.has(row.boxId)) return true;
  const lane = row.lane;
  if (lane?.kind === 'box' && scope.boxIds.has(lane.id.slice('box:'.length))) return true;
  const job = 'key' in row ? jobIdOfKey(row.key) : undefined;
  return job !== undefined && scope.boxJobIds.has(job);
}

/**
 * Ready PRs not merged or closed since, newest first, with whether a message
 * approved them. With `synced` false (no GitHub sync has completed since the hub
 * started), a PR the sync has not confirmed is left out: the log alone cannot
 * tell a PR still ready from one that went red or merged while the hub was down.
 */
export function liveReadyItems(
  events: TimelineEvent[],
  prState?: (repo: string, number: number) => string | undefined,
  synced = true,
): TimelineLiveItem[] {
  const sorted = [...events].sort(newestFirst);
  const samePr = prMatcher(events);
  const finished = new Set<string>();
  for (const ev of sorted) {
    if ((ev.type === 'pr.merged' || ev.type === 'pr.closed') && ev.pr) {
      finished.add(`${ev.pr.repo}#${String(ev.pr.number)}`);
    }
  }
  const seen = new Set<string>();
  const out: TimelineLiveItem[] = [];
  for (const ev of sorted) {
    if (ev.type !== 'pr.ready' || !ev.pr) continue;
    const key = `${ev.pr.repo}#${String(ev.pr.number)}`;
    if (finished.has(key) || seen.has(key)) continue;
    seen.add(key);
    // A PR that went red (or conflicted) after the log recorded it ready is no
    // longer awaiting anyone; the log cannot un-append, the last sync can say so.
    const state = prState?.(ev.pr.repo, ev.pr.number);
    if (state ? state !== 'ready' : !synced) continue;
    const approved = sorted.some((m) => m.type === 'manager.message' && samePr(m.pr, ev.pr));
    out.push({
      id: `live:pr:${key}`,
      type: 'pr.ready',
      at: ev.at,
      pr: ev.pr,
      ...(ev.boxId ? { boxId: ev.boxId } : {}),
      ...(ev.boxName ? { boxName: ev.boxName } : {}),
      ...(ev.branch ? { branch: ev.branch } : {}),
      ...(ev.managerId ? { managerId: ev.managerId } : {}),
      ...(ev.taskIds?.length ? { taskIds: ev.taskIds } : {}),
      awaiting: true,
      ...(approved ? { approved: true } : {}),
    });
  }
  return out;
}

export function buildTimelineSummary(
  // Widened past `TimelineEvent` so the caller can hand it the aggregated, `?managerId=`-narrowed
  // rows: the summary must count what the reader is shown, and a `plan` item is not an event type.
  events: readonly Pick<TimelineItem, 'at' | 'type' | 'pr' | 'task'>[],
  since: string,
  live: TimelineLiveItem[],
  pendingApprovals: number,
): TimelineSummary {
  let merged = 0;
  let additions = 0;
  let deletions = 0;
  let tasksDone = 0;
  for (const ev of events) {
    if (ev.at < since) continue;
    if (ev.type === 'pr.merged') {
      merged += 1;
      additions += ev.pr?.additions ?? 0;
      deletions += ev.pr?.deletions ?? 0;
    } else if (ev.type === 'task.status' && ev.task?.to === 'done') {
      tasksDone += 1;
    }
  }
  const awaitingPrs = live.filter((l) => l.type === 'pr.ready' && !l.approved).length;
  return {
    since,
    merged,
    additions,
    deletions,
    tasksDone,
    awaiting: awaitingPrs + pendingApprovals,
  };
}

export { parseShortstat };

/** Where a row's repo is on the web, from what the GitHub sync already cached. */
export interface RepoWebLookup {
  /** A repo (`owner/name`) a sync resolved. */
  repo(nameWithOwner: string): string | undefined;
  project(projectId: string): string | undefined;
  box(boxId: string): string | undefined;
}

interface BranchRow {
  branch?: string;
  pr?: TimelinePr;
  projectId?: string;
  boxId?: string;
}

/** `https://<host>/<owner>/<name>` from a PR's `…/pull/<n>` URL. */
export function repoUrlOfPrUrl(url: string): string | undefined {
  return /^(https?:\/\/[^/?#]+\/[^/?#]+\/[^/?#]+)\/pull\/\d+\/?(?:[?#].*)?$/u.exec(url)?.[1];
}

/**
 * The branch's page on the repo's host. A PR row's branch is its head, since
 * that is the branch in the repo its URL names. Each segment is encoded on its
 * own, so the `/` of `feat/x` stays a path separator.
 */
export function branchUrlOf(row: BranchRow, lookup: RepoWebLookup): string | undefined {
  const branch = row.pr?.head || row.branch;
  if (!branch) return undefined;
  const repoUrl =
    (row.pr?.url ? repoUrlOfPrUrl(row.pr.url) : undefined) ??
    (row.pr?.repo ? lookup.repo(row.pr.repo) : undefined) ??
    (row.projectId ? lookup.project(row.projectId) : undefined) ??
    (row.boxId ? lookup.box(row.boxId) : undefined);
  if (!repoUrl) return undefined;
  try {
    return `${repoUrl}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;
  } catch {
    // encodeURIComponent throws on a lone surrogate; such a branch gets no link.
    return undefined;
  }
}

function withBranchUrl<T extends BranchRow>(row: T, lookup: RepoWebLookup): T {
  const branchUrl = branchUrlOf(row, lookup);
  return branchUrl ? { ...row, branchUrl } : row;
}

export interface TimelineBackendOptions {
  sync?: GithubPrSync;
  now?: () => number;
  diffTimeoutMs?: number;
}

function orNullAfter<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
    void p.then((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

export function createTimelineBackend(
  deps: BackendDeps,
  opts: TimelineBackendOptions = {},
): TimelineBackend {
  const sync = opts.sync ?? createGithubPrSync(deps);
  const now = opts.now ?? Date.now;
  const diffTimeout = opts.diffTimeoutMs ?? DIFF_TIMEOUT_MS;
  /** The exec promise, not its result: overlapping reads share one exec. */
  const diffCache = new Map<string, { at: number; value: Promise<DiffStat | null> }>();

  function diffOf(box: TimelineBoxFact): Promise<DiffStat | null> {
    if (!deps.boxDiffStat || box.state !== 'running') return Promise.resolve(null);
    let hit = diffCache.get(box.id);
    if (!hit || now() - hit.at >= DIFF_CACHE_MS) {
      hit = { at: now(), value: deps.boxDiffStat(box).catch(() => null) };
      diffCache.set(box.id, hit);
    }
    // A slow exec keeps running and answers a later read from the cache.
    return orNullAfter(hit.value, diffTimeout);
  }

  async function liveBoxItems(
    boxes: TimelineBoxFact[],
    tasks: WorkTask[],
    events: TimelineEvent[],
  ): Promise<TimelineLiveItem[]> {
    const rows = await Promise.all(
      boxes.map(async (box): Promise<TimelineLiveItem | null> => {
        const mine = sortTasksByOrder(tasks.filter((t) => t.boxId === box.id));
        const current = mine.find((t) => t.status === 'in_progress');
        if (!current) return null;
        return liveBoxItem(box, mine, current, events, await diffOf(box));
      }),
    );
    return rows.filter((row): row is TimelineLiveItem => row !== null);
  }

  function liveBoxItem(
    box: TimelineBoxFact,
    mine: WorkTask[],
    current: WorkTask,
    events: TimelineEvent[],
    diff: DiffStat | null,
  ): TimelineLiveItem {
    const since = events.find(
      (ev) =>
        (ev.type === 'task.assigned' && taskIdsOf(ev).includes(current.id)) ||
        (ev.type === 'box.created' && ev.boxId === box.id),
    );
    return {
      id: `live:task:${box.id}`,
      type: 'task.in_progress',
      at: since?.at ?? current.updatedAt,
      boxId: box.id,
      boxName: box.name,
      ...(box.agent ? { agent: box.agent } : {}),
      ...(box.branches[0] ? { branch: box.branches[0] } : {}),
      ...(current.managerId ? { managerId: current.managerId } : {}),
      task: { id: current.id, title: current.title },
      taskIds: mine.filter((t) => t.status !== 'done').map((t) => t.id),
      ...(diff ? diff : {}),
    };
  }

  return {
    async getTimeline(wsId: string, q: TimelineQuery = {}): Promise<TimelineResponse | null> {
      const ws = await readWorkspace(wsId);
      if (!ws) return null;
      const github = q.sync === false ? sync.status(wsId) : sync.kick(ws);
      const [events, workspaces, facts, ctx] = await Promise.all([
        readTimeline(wsId),
        listWorkspaces(),
        deps.boxFacts ? deps.boxFacts().catch(() => []) : Promise.resolve([]),
        reconcileContext(deps),
      ]);
      const tasks = await readReconciledTasks(wsId, ctx);
      const boxes = facts.filter(
        (b) => findWorkspaceContaining(workspaces, b.projectRoot)?.id === wsId,
      );
      // Copies: an aggregated item can be the parsed event itself, and lanes are never stored.
      const all = aggregateTimeline(events).map((i) => ({ ...i }));
      const live = [
        ...(await liveBoxItems(boxes, tasks, events)),
        ...liveReadyItems(events, (repo, n) => sync.prState(repo, n), sync.synced(wsId)),
      ];
      assignLanes(all, live, boxes);
      // Narrowing runs AFTER lanes are assigned and BEFORE paging: a kept row keeps the lane id
      // and fork it has in the whole log, so its `from`/`into` may name a lane with no rows left
      // here — which a graph already handles for a lane that paged off the bottom.
      let scoped = all;
      let liveScoped = live;
      let approvalBoxIds = boxes.map((b) => b.id);
      if (q.managerId) {
        const rec = (await readReconciledManagers(wsId, ctx)).find((m) => m.id === q.managerId);
        // Built over `all` — every row, before paging — so a box the record no longer lists is
        // still attributed from the log. An id no manager has owns nothing and reads as empty.
        const scope = managerScope(q.managerId, all, rec);
        const mine = (row: TimelineItem | TimelineLiveItem): boolean =>
          rowBelongsToManager(row, scope);
        scoped = scoped.filter(mine);
        liveScoped = liveScoped.filter(mine);
        approvalBoxIds = approvalBoxIds.filter((id) => scope.boxIds.has(id));
      }
      let items = scoped;
      if (q.before) items = items.filter((i) => i.at < q.before!);
      items = items.slice(0, q.limit ?? TIMELINE_DEFAULT_LIMIT);
      // Links come from the sync's cache only: a read never waits on `gh`.
      const factById = new Map(facts.map((b) => [b.id, b]));
      const lookup: RepoWebLookup = {
        repo: (repo) => sync.webUrlForRepo(repo),
        project: (id) => sync.webUrlForProject(id),
        box: (id) => {
          const fact = factById.get(id);
          if (!fact) return undefined;
          return sync.webUrlForRoot(fact.projectRoot) ?? sync.webUrlForProject(fact.projectId);
        },
      };
      items = items.map((i) => withBranchUrl(i, lookup));
      const liveRows = liveScoped.map((l) => withBranchUrl(l, lookup));
      const boxIds = new Set(approvalBoxIds);
      const pending = (deps.pendingApprovalBoxIds?.() ?? []).filter((id) => boxIds.has(id)).length;
      return {
        items,
        live: liveRows,
        // Counted over `scoped`, not the raw log: the summary must describe the rows on screen,
        // so `?managerId=` narrows it too. Aggregation drops nothing the summary counts.
        ...(q.since ? { summary: buildTimelineSummary(scoped, q.since, liveRows, pending) } : {}),
        github,
      };
    },
  };
}

// ── box events, recorded around the hub's own box routes ──

/** The fields every box event carries, from what the hub knows about the box. */
async function boxEventBase(
  fact: TimelineBoxFact,
  wsId: string,
): Promise<Omit<TimelineEventInput, 'type' | 'actor'>> {
  // A plain read: reconciling here with only this box live would unassign every other box's tasks.
  const tasks = await readTasks(wsId).catch(() => []);
  const taskIds = tasks.filter((t) => t.boxId === fact.id).map((t) => t.id);
  return {
    boxId: fact.id,
    boxName: fact.name,
    ...(fact.agent ? { agent: fact.agent } : {}),
    ...(fact.branches[0] ? { branch: fact.branches[0] } : {}),
    projectId: fact.projectId,
    ...(taskIds.length ? { taskIds } : {}),
  };
}

export type StampFor = (
  ref: { agent: string; sessionId: string } | { managerId: string },
  wsId: string,
) => Promise<TimelineStamp | undefined>;

const HUMAN: TimelineStamp = { actor: 'human' };

/**
 * The stamp to write into `wsId`'s log. A session the route carried unresolved
 * is resolved against this workspace, and a stamp naming another workspace's
 * manager becomes a human one: that manager's turn means nothing in this log.
 */
export async function stampInWorkspace(
  meta: TimelineMeta | undefined,
  wsId: string,
  stampFor: StampFor,
): Promise<TimelineStamp | undefined> {
  if (meta?.session) return (await stampFor(meta.session, wsId).catch(() => undefined)) ?? HUMAN;
  const stamp = meta?.stamp;
  if (!stamp?.managerId) return stamp;
  const rec = await findManager(stamp.managerId).catch(() => null);
  return rec?.workspaceId === wsId ? stamp : HUMAN;
}

/** How a push route addresses the host ref it moves. */
interface PushTarget {
  remote?: string;
  hostOnly?: boolean;
  /** `push-host --as`: the local branch it lands on. */
  as?: string;
}

export interface BoxTimelineSeams {
  deps: BackendDeps;
  /** A manager's stamp (turn + prompt), only when it is a manager of `wsId`. */
  stampFor: StampFor;
}

/**
 * Wrap the box routes that change what a workspace's timeline says: create,
 * start/stop/destroy, the two pushes, and checkout/new branch. Wrapped rather
 * than threaded through each method's many return paths. Every record runs in
 * the background after the operation answered, so it neither delays the
 * response nor turns a success into a failure.
 */
export function withBoxTimeline(hub: HubBackend, seams: BoxTimelineSeams): HubBackend {
  const { deps } = seams;

  /** The box's persisted record; nothing when no workspace exists to log it in. */
  async function factOf(id: string): Promise<TimelineBoxFact | undefined> {
    if (!deps.boxFact || id.startsWith('job:')) return undefined;
    if ((await listWorkspaces()).length === 0) return undefined;
    return deps.boxFact(id);
  }

  /** Where a push's +/- lines are read, with the ref's tip before the push moves it. */
  async function pushStatBefore(
    fact: TimelineBoxFact | undefined,
    push: PushTarget,
  ): Promise<PushStatInput | undefined> {
    const boxBranch = fact?.branches[0];
    if (!fact || !boxBranch) return undefined;
    const branch = push.hostOnly && push.as ? push.as : boxBranch;
    const ref = pushedRef(branch, push);
    const before = await readRefTip(fact.projectRoot, ref);
    return { repo: fact.projectRoot, ref, branch, ...(before ? { before } : {}) };
  }

  async function recordAround<R extends { ok: boolean }>(
    id: string,
    type: TimelineEvent['type'],
    meta: TimelineMeta | undefined,
    op: () => Promise<R>,
    { push, branchSwitch = false }: { push?: PushTarget; branchSwitch?: boolean } = {},
  ): Promise<R> {
    // A destroyed box has no record left to name it by, a push moves the ref
    // its diff is measured from, and a branch switch replaces the branch it
    // switches away from, so all three are read first. A push still reads the
    // fact again afterwards: the op may have hydrated the box from its Store
    // registration, and then the row is logged without a diff.
    const early = type === 'box.destroyed' || push !== undefined || branchSwitch;
    const before = early ? await factOf(id).catch(() => undefined) : undefined;
    // Kept apart from `before`: a record can be updated in place by the op.
    const previous = before?.branches[0];
    const stat = push ? await pushStatBefore(before, push).catch(() => undefined) : undefined;
    const res = await op();
    if (!res.ok) return res;
    inBackground(async () => {
      // A switch is the branch the hub sanctioned after the op: a checkout that
      // left HEAD detached sanctions nothing, and is not one.
      const after = branchSwitch ? await factOf(id) : undefined;
      if (branchSwitch && (!after?.branches[0] || after.branches[0] === previous)) return;
      const fact = after ?? before ?? (type === 'box.destroyed' ? undefined : await factOf(id));
      if (!fact) return;
      const ws = await workspaceForPath(fact.projectRoot);
      if (!ws) return;
      const [stamp, base, diff] = await Promise.all([
        stampInWorkspace(meta, ws.id, seams.stampFor),
        boxEventBase(fact, ws.id),
        stat ? pushLineStat(stat) : undefined,
      ]);
      await recordTimelineEvent(ws.id, {
        type,
        ...stampFields(stamp),
        ...base,
        ...(diff ?? {}),
        ...(after && previous ? { base: previous } : {}),
      });
      deps.notify();
    });
    return res;
  }

  const create = hub.create.bind(hub);
  const start = hub.start.bind(hub);
  const stop = hub.stop.bind(hub);
  const destroy = hub.destroy.bind(hub);
  const gitPush = hub.gitPush.bind(hub);
  const gitPushHost = hub.gitPushHost.bind(hub);
  const gitCheckout = hub.gitCheckout.bind(hub);
  const gitNewBranch = hub.gitNewBranch.bind(hub);

  hub.create = async (input, meta) => {
    const res = await create(input, meta);
    if (!res.ok || !input.projectId) return res;
    const projectId = input.projectId;
    inBackground(async () => {
      const ws = (await listWorkspaces()).find((w) => w.projectIds.includes(projectId));
      if (!ws) return;
      // The manager a create names is the one the box belongs to, whoever sent it.
      const named = input.managerId
        ? await seams.stampFor({ managerId: input.managerId }, ws.id).catch(() => undefined)
        : undefined;
      const stamp = named ?? (await stampInWorkspace(meta, ws.id, seams.stampFor));
      const name = input.name?.trim();
      const branch = input.opts?.useBranch ?? (name ? `agentbox/${name}` : undefined);
      const base =
        input.fromBranch?.trim() || (await deps.projectBranch?.(projectId).catch(() => undefined));
      await recordTimelineEvent(ws.id, {
        type: 'box.created',
        ...stampFields(stamp),
        key: `job:${res.jobId}:created`,
        ...(name ? { boxName: name } : {}),
        ...(input.agent !== 'none' ? { agent: input.agent } : {}),
        ...(branch ? { branch } : {}),
        ...(base ? { base } : {}),
        projectId,
      });
      deps.notify();
    });
    return res;
  };
  hub.start = (id, meta) => recordAround(id, 'box.started', meta, () => start(id, meta));
  hub.stop = (id, meta) => recordAround(id, 'box.stopped', meta, () => stop(id, meta));
  hub.destroy = (id, o, meta) =>
    recordAround(id, 'box.destroyed', meta, () => destroy(id, o, meta));
  hub.gitPush = (id, input, meta) =>
    recordAround(id, 'git.push', meta, () => gitPush(id, input, meta), {
      push: { ...(input?.remote ? { remote: input.remote } : {}) },
    });
  hub.gitPushHost = (id, input, meta) =>
    recordAround(id, 'git.push', meta, () => gitPushHost(id, input, meta), {
      push: { hostOnly: true, ...(input?.as ? { as: input.as } : {}) },
    });
  // A checkout with args restores paths and switches no branch.
  hub.gitCheckout = (id, branch, args, meta) =>
    args?.length
      ? gitCheckout(id, branch, args, meta)
      : recordAround(id, 'box.branch', meta, () => gitCheckout(id, branch, args, meta), {
          branchSwitch: true,
        });
  hub.gitNewBranch = (id, input, meta) =>
    recordAround(id, 'box.branch', meta, () => gitNewBranch(id, input, meta), {
      branchSwitch: true,
    });
  return hub;
}
