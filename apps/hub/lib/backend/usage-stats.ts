// The usage dashboard's stats (docs/usage-dashboard-plan.md, Phase 2): the hub's
// session history (active intervals, tokens) and the activity ledger (pushes,
// PRs, box lifecycle) adapted to `buildUsageStats` from `@agentbox/usage-view`.
// Served by `GET /api/v1/usage/stats`; the CLI's `agentbox usage` reads it there.
//
// Types only from `@agentbox/relay`: the Next route bundles this file, and a value
// import pulls in the relay's cloud backend loaders.
import type { ActivityEvent, ActivityStore } from '@agentbox/relay';
import {
  AGENT_IDS,
  DEFAULT_IDLE_GAP_MS,
  DEFAULT_TAIL_MS,
  LIMITS,
  PROVIDER_IDS,
  UsageRange,
  addDays,
  buildUsageStats,
  canonicalTimeZone,
  clipSpans,
  concurrency,
  contributionRows,
  dayKey,
  dayStart,
  daysBetween,
  hoursSaved,
  lanesFromSessions,
  totalMs,
  zoneSegments,
  type ActivityEvent as UsageEvent,
  type AgentId,
  type BoxInfo,
  type BoxRun,
  type ProviderId,
  type RangeId,
  type SessionTurns,
  type SubscriptionRow,
  type TokenRow,
  type UsageContribution,
  type UsageStats,
} from '@agentbox/usage-view';
import type { PrDetail } from '../boxes/backend-types';
import type { HistoryRepo, UsageSessionMeta } from './history';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LEDGER_PAGE = 50_000;

export interface UsageStatsQuery {
  id: RangeId;
  /** Local days, `YYYY-MM-DD`, inclusive. */
  since: string;
  until: string;
  today: string;
  /** IANA zone, canonical for this runtime. */
  tz: string;
  /** `agent/account`. */
  subscription?: string;
}

export interface UsageStatsDeps {
  history: Pick<HistoryRepo, 'usageSpans' | 'usageTokens' | 'usageSessions'> | null;
  ledger: Pick<ActivityStore, 'list'> | null;
  /** Other machines' usage contributions (Phase 4b); absent on a hub that takes none. */
  contributions?: { list(): Promise<UsageContribution[]> } | null;
  /** This hub's own machine id: a contribution under it is never merged. */
  selfMachineId?: string;
  /**
   * PR titles and line counts by `owner/name#number`, from the workspace timelines:
   * the ledger keeps only a PR's repo and number.
   */
  prDetails?: () => Promise<ReadonlyMap<string, PrDetail>>;
  now?: () => number;
}


const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** `YYYY-MM-DD` naming a real date (no month 13, no 31 February). */
const isDay = (d: string): boolean =>
  DAY_RE.test(d) &&
  Number.isFinite(Date.parse(`${d}T00:00:00Z`)) &&
  new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const SUBSCRIPTION_RE = /^[A-Za-z0-9._-]{1,64}\/[^\s/]{1,128}$/;

/** A window from the 1st inside one month reads as that month; any other month-long one as 30 days. */
function rangeIdFor(days: number, since: string, until: string): RangeId {
  if (days <= 7) return '7d';
  if (days <= 31) {
    return since.endsWith('-01') && since.slice(0, 7) === until.slice(0, 7) ? 'month' : '30d';
  }
  if (days <= 92) return '90d';
  return 'year';
}

/**
 * The window a request names, checked with `UsageRange`'s own bounds (2020-2100,
 * at most a year) before anything walks its days. `since` is a day or `<n>d` (the
 * last n days through today); `until` a day, default today; `tz` an IANA zone,
 * default UTC.
 */
export function parseUsageStatsQuery(
  raw: { since?: string; until?: string; tz?: string; range?: string; subscription?: string },
  now: number,
): { ok: true; query: UsageStatsQuery } | { ok: false; message: string } {
  const tz = canonicalTimeZone(raw.tz ?? 'UTC');
  if (!tz) return { ok: false, message: 'tz must be an IANA time zone, e.g. Europe/Rome' };
  const today = dayKey(now, tz);
  const until = raw.until ?? today;
  if (!isDay(until)) return { ok: false, message: 'until must be a date, YYYY-MM-DD' };
  let since: string;
  const rel = /^(\d{1,4})([dw])$/.exec(raw.since ?? '30d');
  if (rel) {
    const n = Number(rel[1]) * (rel[2] === 'w' ? 7 : 1);
    if (n < 1) return { ok: false, message: 'since must cover at least one day' };
    since = addDays(until, -(n - 1));
  } else if (raw.since && isDay(raw.since)) {
    since = raw.since;
  } else {
    return {
      ok: false,
      message: 'since must be a date (YYYY-MM-DD) or a number of days or weeks (30d, 2w)',
    };
  }
  if (since > until) return { ok: false, message: 'since must not be after until' };
  if (since > today) return { ok: false, message: 'since must not be in the future' };
  const days =
    Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY) + 1;
  let id: RangeId;
  if (raw.range === undefined) id = rangeIdFor(days, since, until);
  else if (
    raw.range === '7d' ||
    raw.range === '30d' ||
    raw.range === 'month' ||
    raw.range === '90d' ||
    raw.range === 'year'
  )
    id = raw.range;
  else return { ok: false, message: 'range must be one of 7d, 30d, month, 90d, year' };
  const range = { id, since, until, today: until < today ? until : today, tz };
  const parsed = UsageRange.safeParse(range);
  if (!parsed.success) {
    return {
      ok: false,
      message: `invalid window: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }
  const subscription = raw.subscription?.trim() || undefined;
  if (subscription !== undefined && !SUBSCRIPTION_RE.test(subscription)) {
    return { ok: false, message: 'subscription must be <agent>/<account>' };
  }
  return { ok: true, query: { ...range, ...(subscription ? { subscription } : {}) } };
}

const asAgent = (a: string | null | undefined): AgentId =>
  a && (AGENT_IDS as readonly string[]).includes(a) ? (a as AgentId) : 'other';
const asProvider = (p: string | null | undefined): ProviderId =>
  p && (PROVIDER_IDS as readonly string[]).includes(p) ? (p as ProviderId) : 'other';

/** `github.com/owner/repo` reads as `owner/repo`; a local key stays as it is. */
function projectName(key: string | null | undefined): string | null {
  if (!key) return null;
  const parts = key.split('/');
  return parts.length >= 3 && parts[0]!.includes('.') ? parts.slice(1).join('/') : key;
}

const atMs = (e: ActivityEvent): number => Date.parse(e.at);

async function readLedger(
  ledger: Pick<ActivityStore, 'list'>,
  sinceMs: number,
  untilMs: number,
): Promise<ActivityEvent[]> {
  const out: ActivityEvent[] = [];
  const seen = new Set<string>();
  let from = sinceMs;
  // Page on until a read adds nothing: `list` may return fewer rows than it read (it
  // drops a row it cannot parse), so a short page is no sign of the end.
  for (;;) {
    const page = await ledger.list({ sinceMs: from, untilMs, order: 'asc', limit: LEDGER_PAGE });
    let added = 0;
    for (const e of page) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
      added++;
    }
    if (added === 0 || page.length === 0) return out;
    // Restart at the last page's millisecond; `seen` drops the repeats.
    from = atMs(page[page.length - 1]!);
  }
}

/**
 * Pushes to count. A host-only landing publishes nothing, so it counts only when no
 * published push of the same box with commits follows it: that one carries them.
 */
export function countedPushes(rows: readonly ActivityEvent[]): ActivityEvent[] {
  const pushes = rows.filter((e) => e.type === 'git.push');
  const lastPublished = new Map<string, number>();
  for (const e of pushes) {
    // An up-to-date push is a row with no counts: it published nothing.
    if (e.hostOnly || !e.boxId || !(e.commits && e.commits > 0)) continue;
    const t = atMs(e);
    if (t > (lastPublished.get(e.boxId) ?? -Infinity)) lastPublished.set(e.boxId, t);
  }
  return pushes.filter(
    (e) => !e.hostOnly || !e.boxId || !((lastPublished.get(e.boxId) ?? -Infinity) >= atMs(e)),
  );
}

const RUNNING = new Set(['box.created', 'box.ready', 'box.started', 'box.resumed']);
const IDLE = new Set(['box.stopped', 'box.paused', 'box.destroyed', 'box.failed']);

/**
 * Running time per box from its lifecycle rows, each run from a running row to the
 * next stop, pause, failure or destroy; one still running runs until `now`. A stop
 * with no running row before it in the read counts nothing: the box may have been
 * stopped long before.
 */
export function boxRunsOf(
  rows: readonly ActivityEvent[],
  provider: (boxId: string) => ProviderId,
  now: number,
): BoxRun[] {
  const byBox = new Map<string, ActivityEvent[]>();
  for (const e of rows) {
    if (!e.boxId || !(RUNNING.has(e.type) || IDLE.has(e.type))) continue;
    const list = byBox.get(e.boxId);
    if (list) list.push(e);
    else byBox.set(e.boxId, [e]);
  }
  const runs: BoxRun[] = [];
  for (const [boxId, evs] of byBox) {
    let start: number | null = null;
    for (const e of evs) {
      const t = atMs(e);
      if (RUNNING.has(e.type)) start ??= t;
      else if (start !== null) {
        if (t > start) runs.push({ boxId, provider: provider(boxId), start, end: t });
        start = null;
      }
    }
    if (start !== null && now > start)
      runs.push({ boxId, provider: provider(boxId), start, end: now });
  }
  return runs;
}

/** The hub's own rows for `[readFrom, to)`, adapted to `buildUsageStats` input. */
export interface UsageRows {
  sessions: SessionTurns[];
  tokens: TokenRow[];
  events: UsageEvent[];
  boxes: Map<string, BoxInfo>;
  boxRuns: BoxRun[];
  /** The ledger rows read (filtered to the subscription). */
  rows: ActivityEvent[];
  /** Earliest span start read, Infinity when none. */
  firstSpanStart: number;
  /** Token totals per subscription inside `[from, to)`. */
  subs: Map<string, { tokens: number; cost: number | null }>;
  /** Each PR's newest state. */
  prState: Map<string, string>;
  /** Host sessions held here (no box), by agent session id. */
  hostSessionIds: Set<string>;
}

/**
 * Read history and the ledger for `[readFrom, to)` and adapt them. `from` bounds
 * the subscription totals (the window shown, not the read).
 */
export async function loadUsageRows(
  deps: UsageStatsDeps,
  w: { readFrom: number; from: number; to: number; tz: string; account?: string; now: number },
): Promise<UsageRows> {
  const { readFrom, from, to, tz, account, now } = w;
  const [spanRows, tokenRows, ledgerRows, prDetails] = await Promise.all([
    deps.history
      ? deps.history.usageSpans({
          sinceMs: readFrom,
          untilMs: to,
          idleGapMs: DEFAULT_IDLE_GAP_MS,
          ...(account ? { account } : {}),
        })
      : [],
    deps.history
      ? deps.history.usageTokens({
          sinceMs: readFrom,
          untilMs: to,
          zone: zoneSegments(readFrom, to, tz),
          ...(account ? { account } : {}),
        })
      : [],
    // Up to now, not `to`: a published push after the window decides whether a
    // host-only landing inside it counts.
    deps.ledger ? readLedger(deps.ledger, readFrom, Math.max(to, now)) : [],
    deps.prDetails ? deps.prDetails().catch(() => null) : null,
  ]);

  const metaKeys = [...new Set([...spanRows, ...tokenRows].map((r) => r.sessionKey))];
  const metas = new Map<string, UsageSessionMeta>(
    (deps.history && metaKeys.length ? await deps.history.usageSessions(metaKeys) : []).map((m) => [
      m.key,
      m,
    ]),
  );

  // Boxes this subscription's sessions ran in; their ledger rows count with it.
  const subBoxes = new Set<string>();
  for (const m of metas.values()) if (m.boxId) subBoxes.add(m.boxId);
  const rows = ledgerRows.filter(
    (e) => !account || e.account === account || (e.boxId !== undefined && subBoxes.has(e.boxId)),
  );

  // The box facts: the ledger's newest row wins over the transcript's.
  const boxes = new Map<string, BoxInfo>();
  for (const m of metas.values()) {
    if (!m.boxId || boxes.has(m.boxId)) continue;
    boxes.set(m.boxId, {
      boxId: m.boxId,
      name: m.boxName ?? m.boxId,
      project: projectName(m.projectKey),
      agent: asAgent(m.agent),
      provider: asProvider(m.provider ?? 'docker'),
    });
  }
  for (const e of rows) {
    if (!e.boxId) continue;
    const b: BoxInfo = boxes.get(e.boxId) ?? {
      boxId: e.boxId,
      name: e.boxName ?? e.boxId,
      agent: asAgent(e.agent),
      provider: asProvider(e.provider),
    };
    if (e.boxName) b.name = e.boxName;
    if (e.projectKey) b.project = projectName(e.projectKey);
    if (e.agent) b.agent = asAgent(e.agent);
    if (e.provider) b.provider = asProvider(e.provider);
    if (e.managerId) b.managerId = e.managerId;
    boxes.set(e.boxId, b);
  }

  const spansBySession = new Map<string, { start: number; end: number }[]>();
  for (const r of spanRows) {
    const list = spansBySession.get(r.sessionKey) ?? [];
    list.push({ start: r.start, end: r.last + DEFAULT_TAIL_MS });
    spansBySession.set(r.sessionKey, list);
  }
  const sessions: SessionTurns[] = [];
  for (const [key, spans] of spansBySession) {
    const m = metas.get(key);
    if (!m) continue;
    const box = m.boxId ? boxes.get(m.boxId) : undefined;
    sessions.push({
      sessionId: m.sessionId,
      boxId: m.boxId,
      agent: asAgent(m.agent),
      // A session with no box ran on a PC: the "this PC" provider.
      provider: m.boxId ? (box?.provider ?? asProvider(m.provider)) : 'host',
      managerId: box?.managerId ?? null,
      turns: [],
      spans,
    });
  }

  const tokens: TokenRow[] = [];
  const subs = new Map<string, { tokens: number; cost: number | null }>();
  for (const t of tokenRows) {
    const m = metas.get(t.sessionKey);
    if (!m) continue;
    const box = m.boxId ? boxes.get(m.boxId) : undefined;
    // Noon of the local day: inside it whatever the day's length.
    const tAt = dayStart(new Date(t.day * DAY).toISOString().slice(0, 10), tz) + 12 * HOUR;
    tokens.push({
      at: tAt,
      agent: asAgent(m.agent),
      provider: m.boxId ? (box?.provider ?? asProvider(m.provider)) : 'host',
      project: box?.project ?? projectName(m.projectKey),
      boxId: m.boxId,
      ...(m.boxId ? {} : { sessionId: m.sessionId }),
      tokens: t.tokens,
    });
    if (tAt >= from && tAt < to && m.account) {
      const s = subs.get(m.account) ?? { tokens: 0, cost: null };
      s.tokens += t.tokens;
      if (t.costUsd !== null) s.cost = (s.cost ?? 0) + t.costUsd;
      subs.set(m.account, s);
    }
  }
  const events: UsageEvent[] = [];
  for (const e of countedPushes(rows)) {
    events.push({
      type: 'git.push',
      at: atMs(e),
      boxId: e.boxId ?? null,
      project: projectName(e.projectKey),
      commits: e.commits ?? 0,
      files: e.filesChanged ?? 0,
      additions: e.additions ?? 0,
      deletions: e.deletions ?? 0,
    });
  }
  const mergedSeen = new Set<string>();
  const prState = new Map<string, string>();
  for (const e of rows) {
    if (!e.type.startsWith('pr.')) continue;
    const prKey = e.pr ? `${e.pr.repo}#${String(e.pr.number)}` : e.id;
    prState.set(prKey, e.type);
    if (e.type !== 'pr.merged' || mergedSeen.has(prKey)) continue;
    mergedSeen.add(prKey);
    // "Recently merged" lists a PR only with a title: the timeline's, else its branch.
    const detail = e.pr ? prDetails?.get(prKey) : undefined;
    const title = detail?.title ?? e.branch;
    events.push({
      type: 'pr.merged',
      at: atMs(e),
      boxId: e.boxId ?? null,
      project: projectName(e.projectKey),
      ...(e.pr ? { repo: e.pr.repo, number: e.pr.number } : {}),
      ...(e.pr && title ? { title } : {}),
      ...(detail?.additions !== undefined ? { additions: detail.additions } : {}),
      ...(detail?.deletions !== undefined ? { deletions: detail.deletions } : {}),
    });
  }

  const boxRuns = boxRunsOf(rows, (id) => boxes.get(id)?.provider ?? 'other', now);
  const hostSessionIds = new Set<string>();
  for (const m of metas.values()) if (!m.boxId) hostSessionIds.add(m.sessionId);
  return {
    sessions,
    tokens,
    events,
    boxes,
    boxRuns,
    rows,
    firstSpanStart: spanRows.reduce((a, r) => Math.min(a, r.start), Infinity),
    subs,
    prState,
    hostSessionIds,
  };
}

/**
 * Add the stored contributions of other machines (Phase 4b) to `own`, for the
 * read `[readFrom, to)`. A box or host session the hub holds rows for itself is
 * skipped: those rows are the full record.
 */
export function addContributions(
  own: UsageRows,
  contributions: readonly UsageContribution[],
  w: { readFrom: number; to: number; selfMachineId?: string },
): void {
  if (contributions.length === 0) return;
  const sessionBoxIds = new Set<string>();
  for (const s of own.sessions) if (s.boxId) sessionBoxIds.add(s.boxId);
  for (const t of own.tokens) if (t.boxId) sessionBoxIds.add(t.boxId);
  const pushBoxIds = new Set<string>();
  const prBoxIds = new Set<string>();
  const runBoxIds = new Set<string>();
  for (const e of own.rows) {
    if (!e.boxId) continue;
    if (e.type === 'git.push') pushBoxIds.add(e.boxId);
    else if (e.type === 'pr.merged') prBoxIds.add(e.boxId);
    else if (RUNNING.has(e.type) || IDLE.has(e.type)) runBoxIds.add(e.boxId);
  }
  const keys = {
    sessionBoxIds,
    sessionIds: own.hostSessionIds,
    pushBoxIds,
    prBoxIds,
    runBoxIds,
  };
  for (const c of contributions) {
    if (w.selfMachineId && c.machineId === w.selfMachineId) continue;
    const r = contributionRows(c, keys, w.readFrom, w.to);
    own.sessions.push(...r.sessions);
    own.tokens.push(...r.tokens);
    own.events.push(...r.events);
    own.boxRuns.push(...r.boxRuns);
    for (const b of r.boxes) if (!own.boxes.has(b.boxId)) own.boxes.set(b.boxId, b);
    for (const s of r.sessions) {
      const first = s.spans?.reduce((a, sp) => Math.min(a, sp.start), Infinity) ?? Infinity;
      if (first < own.firstSpanStart) own.firstSpanStart = first;
    }
  }
}

/** Load the window's rows (plus other machines' contributions) and build its `UsageStats`. */
export async function computeUsageStats(
  deps: UsageStatsDeps,
  q: UsageStatsQuery,
): Promise<UsageStats> {
  const now = (deps.now ?? Date.now)();
  const tz = q.tz;
  const lastDay = q.today < q.until ? q.today : q.until;
  const from = dayStart(q.since, tz);
  const to = dayStart(addDays(lastDay, 1), tz);
  const windowDays = daysBetween(q.since, lastDay).length;
  const prevSince = addDays(q.since, -windowDays);
  const prevFrom = dayStart(prevSince, tz);
  const wallFrom = dayStart(addDays(lastDay, -(LIMITS.wallDays - 1)), tz);
  // The wall looks a year back and the KPI deltas one window back: read both at once.
  const readFrom = Math.min(prevFrom, wallFrom);
  const account = q.subscription;

  const own = await loadUsageRows(deps, {
    readFrom,
    from,
    to,
    tz,
    now,
    ...(account ? { account } : {}),
  });
  // A contribution carries no subscription, so a subscription view is this hub's rows only.
  if (!account && deps.contributions) {
    addContributions(own, await deps.contributions.list(), {
      readFrom,
      to,
      ...(deps.selfMachineId ? { selfMachineId: deps.selfMachineId } : {}),
    });
  }
  const { sessions, tokens, events, boxes, boxRuns, rows, subs, prState } = own;

  const subscriptions: SubscriptionRow[] = [...subs]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, LIMITS.subscriptions)
    .map(([key, s]) => ({
      agent: asAgent(key.split('/')[0]),
      label: key.slice(0, LIMITS.name),
      tokens: Math.round(s.tokens),
      cost: s.cost === null ? null : Math.round(s.cost * 100) / 100,
    }));

  // The previous window of the same length, when there is anything before this one.
  const hasEarlier = own.firstSpanStart < from || rows.some((e) => atMs(e) < from);
  let previous:
    | { peak: number; speedup: number; hoursSaved: number; prsMerged: number; boxHours: number }
    | undefined;
  if (hasEarlier) {
    const c = concurrency(lanesFromSessions(sessions), prevFrom, from);
    previous = {
      peak: c.peak,
      speedup: c.wallMs > 0 ? Math.round((c.agentMs / c.wallMs) * 100) / 100 : 0,
      hoursSaved: hoursSaved({ agentHours: c.agentMs / HOUR, wallHours: c.wallMs / HOUR }),
      prsMerged: events.filter((e) => e.type === 'pr.merged' && e.at >= prevFrom && e.at < from)
        .length,
      boxHours:
        Math.round(
          (boxRuns.reduce(
            (a, r) => a + totalMs(clipSpans([{ start: r.start, end: r.end }], prevFrom, from)),
            0,
          ) /
            HOUR) *
            10,
        ) / 10,
    };
  }

  // Live counters only make sense for a window that reaches today.
  const live = q.until >= dayKey(now, tz);
  const lastState = new Map<string, string>();
  for (const e of rows) {
    if (e.boxId && (RUNNING.has(e.type) || IDLE.has(e.type))) lastState.set(e.boxId, e.type);
  }
  const runningNow = live ? [...lastState.values()].filter((t) => RUNNING.has(t)).length : 0;
  const waitingReview = live
    ? [...prState.values()].filter((t) => t === 'pr.opened' || t === 'pr.ready').length
    : 0;

  return buildUsageStats({
    range: { id: q.id, since: q.since, until: q.until, today: q.today, tz },
    now,
    sessions,
    events,
    tokens,
    boxes: [...boxes.values()],
    boxRuns,
    subscriptions,
    ...(previous ? { previous } : {}),
    runningNow,
    waitingReview,
  });
}

// ── a short cache: the page asks again on every range or filter click ──

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 32;
// On globalThis: the custom server and Next's route bundle each carry their own copy
// of this module, and a contribution stored by one must clear the cache the other reads.
const shared = globalThis as typeof globalThis & {
  __AGENTBOX_USAGE_STATS_CACHE?: Map<string, { at: number; value: Promise<UsageStats> }>;
};
const cache = (shared.__AGENTBOX_USAGE_STATS_CACHE ??= new Map());

/** `computeUsageStats`, shared for a minute per (window, zone, subscription). */
export function usageStats(deps: UsageStatsDeps, q: UsageStatsQuery): Promise<UsageStats> {
  const now = (deps.now ?? Date.now)();
  const key = JSON.stringify([q.id, q.since, q.until, q.today, q.tz, q.subscription ?? null]);
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = computeUsageStats(deps, q);
  cache.set(key, { at: now, value });
  // A failed read is not kept.
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  if (cache.size > CACHE_MAX) {
    for (const [k, v] of cache)
      if (now - v.at >= CACHE_TTL_MS || cache.size > CACHE_MAX) cache.delete(k);
  }
  return value;
}

/** Drop every cached answer (a stored contribution or a box's final flush changes them; tests). */
export function clearUsageStatsCache(): void {
  cache.clear();
}

/**
 * After a box's final flush: fold its last turns into the usage intervals now
 * rather than at the next minute sweep, and drop the stats cache so the next
 * read of `/api/v1/usage/stats` sees them.
 */
export async function refreshUsageAfterFlush(): Promise<void> {
  try {
    await globalThis.__AGENTBOX_HUB_HISTORY?.refreshUsageSpans();
  } finally {
    clearUsageStatsCache();
  }
}
