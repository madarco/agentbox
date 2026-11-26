// The activity ledger, hub side (docs/usage-dashboard-plan.md, Phase 1): the
// box routes' writer, the box context every other writer's rows are filled
// from, and a PR sweep for the boxes no workspace's GitHub sync covers. Reads
// go to the store itself (`ActivityStore.list`), as `GET /api/v1/activity` does. The store and the relay-side writers (box
// pushes, the `gh` shim, create jobs, autopause) live in `@agentbox/relay`.
import { repoKey } from '@agentbox/config';
import {
  activityLedger,
  GH_PR_JSON_FIELDS,
  ghRepoArg,
  managerIdForTarget,
  parsePrUrl,
  prTimelineEvents,
  recordActivity,
  type ActivityActor,
  type ActivityBoxContext,
  type ActivityInput,
  type ActivityStore,
  type ActivityType,
  type GhPrJson,
} from '@agentbox/relay';
import type { ActionResult, HubBackend, TimelineMeta } from '../boxes/backend-types';
import { inBackground } from './background';
import type { BackendDeps, GhExec, TimelineBoxFact } from './deps';
import { measurePush, pushStatSourceBefore, type PushTarget } from './push-measure';

// ── box context ──

/** What a Store registration adds for a box this hub has no record of (a PC's cloud box on a control box). */
export interface RegisteredBoxLite {
  name?: string;
  originUrl?: string;
  provider?: string;
}

export function contextOfFact(fact: TimelineBoxFact): ActivityBoxContext {
  return {
    boxName: fact.name,
    ...(fact.provider ? { provider: fact.provider } : {}),
    ...(fact.agent ? { agent: fact.agent } : {}),
    ...(fact.account ? { account: fact.account } : {}),
    ...(fact.originUrl ? { repoUrl: fact.originUrl } : {}),
    ...(fact.branches[0] ? { branch: fact.branches[0] } : {}),
  };
}

/**
 * The hub's reader of a box's context: its record (with the subscription and
 * the repo), else its Store registration, plus the manager it belongs to.
 * Installed over the relay's default with `configureActivityBoxContext`.
 */
export function activityBoxContext(
  deps: Pick<BackendDeps, 'boxFact'>,
  registration?: (boxId: string) => Promise<RegisteredBoxLite | undefined>,
): (boxId: string) => Promise<ActivityBoxContext | undefined> {
  return async (boxId) => {
    const [fact, managerId] = await Promise.all([
      deps.boxFact?.(boxId).catch(() => undefined),
      managerIdForTarget({ boxId }).catch(() => undefined),
    ]);
    let ctx: ActivityBoxContext | undefined = fact ? contextOfFact(fact) : undefined;
    if (!ctx && registration) {
      const reg = await registration(boxId).catch(() => undefined);
      if (reg) {
        ctx = {
          ...(reg.name ? { boxName: reg.name } : {}),
          ...(reg.provider ? { provider: reg.provider } : {}),
          ...(reg.originUrl ? { repoUrl: reg.originUrl } : {}),
        };
      }
    }
    if (managerId) ctx = { ...ctx, managerId };
    return ctx;
  };
}

// ── the box routes ──

function actorOf(meta: TimelineMeta | undefined): ActivityActor {
  const actor = meta?.stamp?.actor;
  if (actor === 'manager' || actor === 'box' || actor === 'hub' || actor === 'github') return actor;
  return meta?.session ? 'manager' : 'human';
}

/**
 * Record the box routes' lifecycle and pushes for every box. Wrapped like the
 * timeline (`withBoxTimeline`), and like it, every row is written after the
 * route has answered, in the background.
 */
export function withBoxActivity(hub: HubBackend, deps: BackendDeps): HubBackend {
  const record = (input: ActivityInput): void => {
    if (!activityLedger()) return;
    inBackground(() => recordActivity(input));
  };
  /** A synthetic `job:` row is a create still in flight: nothing to log against. */
  const real = (id: string): boolean => !id.startsWith('job:');

  const lifecycle =
    (type: ActivityType, op: (id: string, meta?: TimelineMeta) => Promise<ActionResult>) =>
    async (id: string, meta?: TimelineMeta): Promise<ActionResult> => {
      const res = await op(id, meta);
      if (res.ok && real(id)) record({ type, boxId: id, actor: actorOf(meta) });
      return res;
    };

  async function pushAround<R extends { ok: boolean }>(
    id: string,
    meta: TimelineMeta | undefined,
    push: PushTarget,
    op: () => Promise<R>,
  ): Promise<R> {
    // The ref's tip is read before the push moves it.
    const fact =
      activityLedger() && real(id) ? await deps.boxFact?.(id).catch(() => undefined) : undefined;
    const src = fact
      ? await pushStatSourceBefore(deps, fact, push).catch(() => undefined)
      : undefined;
    const res = await op();
    if (!res.ok || !fact) return res;
    inBackground(async () => {
      const diff = src ? await measurePush(deps, src).catch(() => undefined) : undefined;
      const branch = push.hostOnly && push.as ? push.as : fact.branches[0];
      await recordActivity({
        type: 'git.push',
        boxId: id,
        actor: actorOf(meta),
        ...contextOfFact(fact),
        ...(branch ? { branch } : {}),
        ...(push.hostOnly ? { hostOnly: true } : {}),
        ...(diff ?? {}),
      });
    });
    return res;
  }

  const create = hub.create.bind(hub);
  const destroy = hub.destroy.bind(hub);
  const gitPush = hub.gitPush.bind(hub);
  const gitPushHost = hub.gitPushHost.bind(hub);

  hub.create = async (input, meta) => {
    const res = await create(input, meta);
    if (!res.ok) return res;
    const name = input.name?.trim();
    record({
      // The same key the workspace timeline gives it, so the backfill skips it.
      id: `job:${res.jobId}:created`,
      type: 'box.created',
      actor: input.managerId ? 'manager' : actorOf(meta),
      jobId: res.jobId,
      provider: input.provider?.trim() || 'docker',
      ...(name ? { boxName: name } : {}),
      ...(input.agent !== 'none' ? { agent: input.agent } : {}),
      ...(input.repoUrl ? { repoUrl: input.repoUrl } : {}),
      ...(input.managerId ? { managerId: input.managerId } : {}),
    });
    return res;
  };
  hub.start = lifecycle('box.started', hub.start.bind(hub));
  hub.stop = lifecycle('box.stopped', hub.stop.bind(hub));
  hub.pause = lifecycle('box.paused', hub.pause.bind(hub));
  hub.resume = lifecycle('box.resumed', hub.resume.bind(hub));
  hub.destroy = async (id, o, meta) => {
    // Read first: a destroyed box has no record left to name it by.
    const fact =
      activityLedger() && real(id) ? await deps.boxFact?.(id).catch(() => undefined) : undefined;
    const res = await destroy(id, o, meta);
    if (res.ok && real(id)) {
      record({
        type: 'box.destroyed',
        boxId: id,
        actor: actorOf(meta),
        ...(fact ? contextOfFact(fact) : {}),
      });
    }
    return res;
  };
  hub.gitPush = (id, input, meta) =>
    pushAround(id, meta, { ...(input?.remote ? { remote: input.remote } : {}) }, () =>
      gitPush(id, input, meta),
    );
  hub.gitPushHost = (id, input, meta) =>
    pushAround(id, meta, { hostOnly: true, ...(input?.as ? { as: input.as } : {}) }, () =>
      gitPushHost(id, input, meta),
    );
  return hub;
}

// ── PRs for boxes outside a workspace ──

export const ACTIVITY_PR_SWEEP_INTERVAL_MS = 5 * 60_000;
/** How far back a box's branch is still asked about. */
const PR_SWEEP_WINDOW_MS = 30 * 24 * 60 * 60_000;
const PR_SWEEP_LIST_LIMIT = 100;

const PR_TYPES = new Set<ActivityType>(['pr.opened', 'pr.ready', 'pr.merged', 'pr.closed']);
/** The rows that name a box's branch, and the PR states that close one. */
const SWEEP_TYPES: ActivityType[] = ['box.created', 'box.ready', 'git.push', ...PR_TYPES];

interface SweepBranch {
  boxId?: string;
  boxName?: string;
  workspaceId?: string;
  managerId?: string;
}

/**
 * The workspace GitHub sync only polls the repos a workspace names. Every other
 * box's PR — opened from the host, merged on github.com — is found here, by the
 * (repo, branch) pairs the ledger already holds for boxes and pushes. The keys
 * are the sync's (`pr:<repo>#<n>:<kind>`), so a PR both see lands once.
 */
export async function sweepActivityPrs(opts: {
  ledger: ActivityStore;
  gh: GhExec;
  now?: number;
}): Promise<number> {
  const now = opts.now ?? Date.now();
  const since = now - PR_SWEEP_WINDOW_MS;
  // Newest first when the window is over the cap: a recent box matters more.
  const rows = await opts.ledger.list({
    sinceMs: since,
    types: SWEEP_TYPES,
    order: 'desc',
    limit: 50_000,
  });
  const seen = new Set<string>();
  /** `<projectKey>\n<branch>` -> the latest merge/close, and the latest work, in ms. */
  const lastClosed = new Map<string, number>();
  const lastWork = new Map<string, number>();
  const later = (m: Map<string, number>, k: string, at: number): void => {
    if (at > (m.get(k) ?? 0)) m.set(k, at);
  };
  /** projectKey -> repoUrl, branch -> who worked on it. */
  const repos = new Map<string, { repoUrl: string; branches: Map<string, SweepBranch> }>();
  for (const r of rows) {
    const at = Date.parse(r.at);
    if (PR_TYPES.has(r.type)) {
      seen.add(r.id);
      if ((r.type === 'pr.merged' || r.type === 'pr.closed') && r.projectKey && r.branch) {
        later(lastClosed, `${r.projectKey}\n${r.branch}`, at);
      }
      continue;
    }
    if (!r.repoUrl || !r.branch) continue;
    const key = r.projectKey ?? repoKey(r.repoUrl);
    if (!key) continue;
    later(lastWork, `${key}\n${r.branch}`, at);
    let repo = repos.get(key);
    if (!repo) {
      repo = { repoUrl: r.repoUrl, branches: new Map() };
      repos.set(key, repo);
    }
    // Rows come newest first, so the newest box on a branch is the one kept.
    const prev = repo.branches.get(r.branch) ?? {};
    repo.branches.set(r.branch, {
      ...(r.boxId ? { boxId: r.boxId } : {}),
      ...(r.boxName ? { boxName: r.boxName } : {}),
      ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
      ...(r.managerId ? { managerId: r.managerId } : {}),
      ...prev,
    });
  }
  // A branch whose PR was merged or closed after its last push is done; work
  // after that (a new PR from the same branch) asks again.
  const done = (k: string): boolean => (lastClosed.get(k) ?? 0) >= (lastWork.get(k) ?? 0);
  const sinceDay = new Date(since).toISOString().slice(0, 10);
  let recorded = 0;
  for (const [key, repo] of repos) {
    const open = [...repo.branches.keys()].filter((b) => !done(`${key}\n${b}`));
    if (open.length === 0) continue;
    const arg = ghRepoArg(repo.repoUrl);
    if (!arg) continue;
    const r = await opts
      .gh([
        'pr',
        'list',
        '--repo',
        arg,
        '--state',
        'all',
        '--limit',
        String(PR_SWEEP_LIST_LIMIT),
        '--search',
        `updated:>=${sinceDay}`,
        '--json',
        GH_PR_JSON_FIELDS,
      ])
      .catch(() => null);
    if (!r || r.exitCode !== 0) continue;
    let prs: GhPrJson[];
    try {
      prs = JSON.parse(r.stdout) as GhPrJson[];
    } catch {
      continue;
    }
    for (const pr of prs) {
      const who = open.includes(pr.headRefName) ? repo.branches.get(pr.headRefName) : undefined;
      if (!who) continue;
      // The canonical `owner/name` from GitHub's own URL: the sync keys by it.
      const parsed = parsePrUrl(pr.url);
      if (!parsed) continue;
      for (const ev of prTimelineEvents(pr, parsed.repo, { actor: 'github' })) {
        if (!ev.key || seen.has(ev.key)) continue;
        const row = await recordActivity({
          id: ev.key,
          type: ev.type as ActivityType,
          actor: 'github',
          ...(ev.at ? { at: ev.at } : {}),
          branch: pr.headRefName,
          repoUrl: repo.repoUrl,
          pr: { repo: parsed.repo, number: pr.number, url: pr.url },
          ...who,
        });
        if (row) recorded += 1;
      }
    }
  }
  return recorded;
}

/** Run the sweep on an interval. Returns the stop function. */
export function startActivityPrSweep(opts: {
  gh: GhExec;
  intervalMs?: number;
  log?: (line: string) => void;
}): () => void {
  let running = false;
  const tick = (): void => {
    const ledger = activityLedger();
    if (running || !ledger) return;
    running = true;
    void sweepActivityPrs({ ledger, gh: opts.gh })
      .then((n) => {
        if (n > 0)
          opts.log?.(`activity: recorded ${String(n)} PR event(s) for boxes outside a workspace`);
      })
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, opts.intervalMs ?? ACTIVITY_PR_SWEEP_INTERVAL_MS);
  timer.unref?.();
  const first = setTimeout(tick, 30_000);
  first.unref?.();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
