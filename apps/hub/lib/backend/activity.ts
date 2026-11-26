// The activity ledger, hub side (docs/usage-dashboard-plan.md, Phase 1): the
// box routes' writer, the box context every other writer's rows are filled
// from, and a PR sweep for the boxes no workspace's GitHub sync covers. Reads
// go to the store itself (`ActivityStore.list`), as `GET /api/v1/activity` does. The store and the relay-side writers (box
// pushes, the `gh` shim, create jobs, autopause) live in `@agentbox/relay`.
import { repoKey } from '@agentbox/config';
import {
  activityLedger,
  configureActivityBoxContext,
  GH_PR_JSON_FIELDS,
  ghRepoArg,
  listWorkspaces,
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
import type { ActionResult, BoxOpResult, HubBackend, TimelineMeta } from '../boxes/backend-types';
import { inBackground } from './background';
import type { BackendDeps, GhExec, TimelineBoxFact } from './deps';
import { measurePushResult, pushedBranch, type PushTarget } from './push-measure';

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

/** The slice of the relay's Store a registration is read from. */
export interface RegistrationStore {
  getBox(
    boxId: string,
  ): Promise<
    { name: string; originUrl?: string; kind?: string; backend?: string } | null | undefined
  >;
}

/** Fill every ledger row a box id names from this hub's record of it, else its Store registration. */
export function installActivityBoxContext(
  deps: Pick<BackendDeps, 'boxFact'>,
  store: RegistrationStore,
): void {
  configureActivityBoxContext(
    activityBoxContext(deps, async (boxId) => {
      const reg = await store.getBox(boxId);
      if (!reg) return undefined;
      return {
        name: reg.name,
        ...(reg.originUrl ? { originUrl: reg.originUrl } : {}),
        provider: reg.kind === 'cloud' && reg.backend ? reg.backend : 'docker',
      };
    }),
  );
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

  async function pushAround<R extends BoxOpResult>(
    id: string,
    meta: TimelineMeta | undefined,
    push: PushTarget,
    op: () => Promise<R>,
  ): Promise<R> {
    // Nothing is read before the push: git's own output says what it moved.
    const res = await op();
    if (!res.ok || !real(id) || !activityLedger()) return res;
    inBackground(async () => {
      const fact = await deps.boxFact?.(id).catch(() => undefined);
      if (!fact) return;
      const m = await measurePushResult(deps, fact, push, res);
      // A landing that moved nothing landed nothing.
      if (push.hostOnly && m.unmoved) return;
      // A box that pushes with its own credentials (direct, or a control-plane
      // lease) reports the push too, keyed by its new tip; the same key here
      // keeps one row whichever arrives first.
      const after =
        !push.hostOnly && m.tips
          ? await deps.boxRefTip?.(id, m.tips.after ?? 'HEAD').catch(() => undefined)
          : undefined;
      const branch = pushedBranch(fact, push);
      await recordActivity({
        ...(after ? { id: `push:${id}:${after}` } : {}),
        type: 'git.push',
        boxId: id,
        actor: actorOf(meta),
        ...contextOfFact(fact),
        ...(branch ? { branch } : {}),
        ...(push.hostOnly ? { hostOnly: true } : {}),
        ...(m.diff ?? {}),
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

/** Open branches asked about per sweep, newest first. */
const PR_SWEEP_BRANCH_LIMIT = 500;

interface SweepBranch {
  boxId?: string;
  boxName?: string;
  workspaceId?: string;
  managerId?: string;
}

/** The repos a workspace names: the workspace GitHub sync already polls them. */
export async function workspaceRepoKeys(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ws of await listWorkspaces().catch(() => [])) {
    for (const p of ws.projects) {
      const key = repoKey(p.repoUrl);
      if (key) out.add(key);
    }
  }
  return out;
}

/**
 * The workspace GitHub sync only polls the repos a workspace names. Every other
 * box's PR — opened from the host, merged on github.com — is found here, by the
 * open (repo, branch) pairs the ledger holds for boxes and pushes. The keys are
 * the sync's (`pr:<repo>#<n>:<kind>`), so a PR both see lands once.
 */
export async function sweepActivityPrs(opts: {
  ledger: ActivityStore;
  gh: GhExec;
  now?: number;
  /** Repo keys (`repoKey`) to leave to the workspace sync. */
  skipRepos?: ReadonlySet<string>;
}): Promise<number> {
  const now = opts.now ?? Date.now();
  const since = now - PR_SWEEP_WINDOW_MS;
  // A branch whose PR was merged or closed after its last work is not open;
  // work after that (a new PR from the same branch) opens it again.
  const rows = await opts.ledger.openBranches(since, PR_SWEEP_BRANCH_LIMIT);
  /** projectKey -> repoUrl, branch -> its newest box. */
  const repos = new Map<string, { repoUrl: string; branches: Map<string, SweepBranch> }>();
  for (const r of rows) {
    if (!r.repoUrl || !r.branch || !r.projectKey || opts.skipRepos?.has(r.projectKey)) continue;
    let repo = repos.get(r.projectKey);
    if (!repo) {
      repo = { repoUrl: r.repoUrl, branches: new Map() };
      repos.set(r.projectKey, repo);
    }
    repo.branches.set(r.branch, {
      ...(r.boxId ? { boxId: r.boxId } : {}),
      ...(r.boxName ? { boxName: r.boxName } : {}),
      ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
      ...(r.managerId ? { managerId: r.managerId } : {}),
    });
  }
  const sinceDay = new Date(since).toISOString().slice(0, 10);
  let recorded = 0;
  for (const repo of repos.values()) {
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
    const inputs: ActivityInput[] = [];
    for (const pr of prs) {
      const who = repo.branches.get(pr.headRefName);
      if (!who) continue;
      // The canonical `owner/name` from GitHub's own URL: the sync keys by it.
      const parsed = parsePrUrl(pr.url);
      if (!parsed) continue;
      for (const ev of prTimelineEvents(pr, parsed.repo, { actor: 'github' })) {
        if (!ev.key) continue;
        inputs.push({
          id: ev.key,
          type: ev.type as ActivityType,
          actor: 'github',
          ...(ev.at ? { at: ev.at } : {}),
          branch: pr.headRefName,
          repoUrl: repo.repoUrl,
          pr: { repo: parsed.repo, number: pr.number, url: pr.url },
          ...who,
        });
      }
    }
    if (inputs.length === 0) continue;
    const held = await opts.ledger.has(inputs.map((i) => i.id!));
    for (const input of inputs) {
      if (held.has(input.id!)) continue;
      if (await recordActivity(input)) recorded += 1;
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
    void workspaceRepoKeys()
      .then((skipRepos) => sweepActivityPrs({ ledger, gh: opts.gh, skipRepos }))
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
