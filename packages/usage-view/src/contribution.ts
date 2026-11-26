// A PC's usage contribution to a remote hub (docs/usage-dashboard-plan.md, Phase 4b).
//
// With a remote control box, local docker boxes and this PC's own sessions stay in
// the PC's hub. Their transcripts never leave it; their metrics do: the PC's hub
// posts this shape to the control box (`POST /api/v1/usage/contributions`), which
// merges it into its own `/api/v1/usage/stats`. It carries only what the dashboard
// counts: active intervals, token totals per day, shipped counts per day and box
// running time, each keyed by ids. No transcript text, no names, no repo, branch or
// project strings: every string is an id from a closed character set, a fixed enum,
// a date or a time-zone name the runtime lists.
import { z } from 'zod';
import {
  addDays,
  dayKey,
  dayStart,
  type ActivityEvent,
  type BoxInfo,
  type BoxRun,
  type SessionTurns,
  type TokenRow,
} from './aggregate.js';
import { AgentId, ProviderId, isTimeZone, type AgentId as Agent } from './schema.js';

const DAY_MS = 86_400_000;

/** Bounds of one contribution body. A year of a busy PC is well under them. */
export const CONTRIBUTION_LIMITS = {
  /** Raw body bytes. */
  bytes: 8 * 1024 * 1024,
  /** Days one window may cover. */
  windowDays: 400,
  intervals: 50_000,
  tokens: 50_000,
  shipped: 50_000,
  boxes: 10_000,
  boxRuns: 50_000,
} as const;

/** Box, session, manager and machine ids: no spaces, no free text. */
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const Id = z.string().regex(ID_RE);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const Day = z
  .string()
  .regex(DAY_RE)
  .refine((d) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d && d >= '2020-01-01';
  }, 'not a date');
/** Epoch ms between 2020 and 2100. */
const Ms = z.number().int().min(1_577_836_800_000).max(4_102_444_800_000);
const Count = z.number().int().min(0).max(1e12);
const Zone = z.string().max(64).refine(isTimeZone, 'not a time zone this runtime lists');

/** One active interval of an agent. A host session (no box) names its session id. */
export const ContribInterval = z
  .object({
    boxId: Id.nullable(),
    sessionId: Id.optional(),
    agent: AgentId,
    provider: ProviderId,
    start: Ms,
    end: Ms,
  })
  .strict()
  .refine((i) => i.end > i.start, 'end must be after start')
  .refine(
    (i) => i.boxId !== null || i.sessionId !== undefined,
    'a host interval names its session',
  );

/** Tokens of one agent on one local day, per box (null: a host session). */
export const ContribTokens = z
  .object({
    day: Day,
    agent: AgentId,
    provider: ProviderId,
    boxId: Id.nullable(),
    tokens: Count,
  })
  .strict();

/** What one box (or no box) shipped on one local day, from the activity ledger. */
export const ContribShipped = z
  .object({
    day: Day,
    boxId: Id.nullable(),
    pushes: Count,
    commits: Count,
    files: Count,
    additions: Count,
    deletions: Count,
    prsMerged: Count,
  })
  .strict();

/** A box's facts the dashboard groups by. Its name stays on the PC. */
export const ContribBox = z
  .object({
    boxId: Id,
    agent: AgentId,
    provider: ProviderId,
    managerId: Id.optional(),
  })
  .strict();

export const ContribBoxRun = z
  .object({ boxId: Id, provider: ProviderId, start: Ms, end: Ms })
  .strict()
  .refine((r) => r.end > r.start, 'end must be after start');

export const UsageContribution = z
  .object({
    v: z.literal(1),
    /** The PC's `~/.agentbox/machine-id`. */
    machineId: Id,
    /** The local days this push covers, inclusive, in `tz`: it replaces what is stored for them. */
    window: z.object({ since: Day, until: Day }).strict(),
    tz: Zone,
    intervals: z.array(ContribInterval).max(CONTRIBUTION_LIMITS.intervals),
    tokens: z.array(ContribTokens).max(CONTRIBUTION_LIMITS.tokens),
    shipped: z.array(ContribShipped).max(CONTRIBUTION_LIMITS.shipped),
    boxes: z.array(ContribBox).max(CONTRIBUTION_LIMITS.boxes),
    boxRuns: z.array(ContribBoxRun).max(CONTRIBUTION_LIMITS.boxRuns),
  })
  .strict()
  .refine((c) => c.window.since <= c.window.until, 'window.since must not be after window.until')
  .refine(
    (c) =>
      (Date.parse(`${c.window.until}T00:00:00Z`) - Date.parse(`${c.window.since}T00:00:00Z`)) /
        DAY_MS <
      CONTRIBUTION_LIMITS.windowDays,
    `window must cover at most ${String(CONTRIBUTION_LIMITS.windowDays)} days`,
  );
export type UsageContribution = z.infer<typeof UsageContribution>;
export type ContribInterval = z.infer<typeof ContribInterval>;
export type ContribTokens = z.infer<typeof ContribTokens>;
export type ContribShipped = z.infer<typeof ContribShipped>;
export type ContribBox = z.infer<typeof ContribBox>;
export type ContribBoxRun = z.infer<typeof ContribBoxRun>;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Parse a raw contribution body: size cap, no prototype keys, then the strict schema. */
export function parseContributionBody(rawText: string): UsageContribution {
  if (new TextEncoder().encode(rawText).length > CONTRIBUTION_LIMITS.bytes) {
    throw new Error(`contribution body over ${String(CONTRIBUTION_LIMITS.bytes)} bytes`);
  }
  const json: unknown = JSON.parse(rawText, (key, value: unknown) => {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`forbidden key in contribution body: ${key}`);
    return value;
  });
  return UsageContribution.parse(json);
}

// ── the PC side: project the hub's usage input to a contribution ──

export interface ContributionSource {
  sessions: readonly SessionTurns[];
  tokens: readonly TokenRow[];
  events: readonly ActivityEvent[];
  boxes: readonly BoxInfo[];
  boxRuns: readonly BoxRun[];
}

const idOk = (s: string | null | undefined): s is string => !!s && ID_RE.test(s);

/**
 * The contribution for the local days `since..until` in `tz`: the same rows the PC's
 * own stats are built from, cut to ids and numbers. Anything keyed by an id that
 * does not fit the id charset is dropped, never sent.
 */
export function toContribution(
  src: ContributionSource,
  opts: { machineId: string; since: string; until: string; tz: string },
): UsageContribution {
  const { tz } = opts;
  const from = dayStart(opts.since, tz);
  const to = dayStart(addDays(opts.until, 1), tz);
  const inDays = (at: number): boolean => at >= from && at < to;

  const intervals: ContribInterval[] = [];
  for (const s of src.sessions) {
    if (s.boxId !== null && !idOk(s.boxId)) continue;
    if (s.boxId === null && !idOk(s.sessionId)) continue;
    for (const sp of s.spans ?? []) {
      if (sp.end <= from || sp.start >= to || sp.end <= sp.start) continue;
      intervals.push({
        boxId: s.boxId,
        ...(s.boxId === null ? { sessionId: s.sessionId } : {}),
        agent: s.agent,
        provider: s.provider,
        start: sp.start,
        end: sp.end,
      });
    }
  }

  const tokenMap = new Map<string, ContribTokens>();
  for (const t of src.tokens) {
    if (!inDays(t.at) || t.tokens <= 0) continue;
    const boxId = t.boxId ?? null;
    if (boxId !== null && !idOk(boxId)) continue;
    const day = dayKey(t.at, tz);
    const key = JSON.stringify([day, t.agent, t.provider, boxId]);
    const row = tokenMap.get(key) ?? {
      day,
      agent: t.agent,
      provider: t.provider,
      boxId,
      tokens: 0,
    };
    row.tokens += Math.round(t.tokens);
    tokenMap.set(key, row);
  }

  const shippedMap = new Map<string, ContribShipped>();
  for (const e of src.events) {
    if (!inDays(e.at)) continue;
    const boxId = e.boxId ?? null;
    if (boxId !== null && !idOk(boxId)) continue;
    const day = dayKey(e.at, tz);
    const key = JSON.stringify([day, boxId]);
    const row = shippedMap.get(key) ?? {
      day,
      boxId,
      pushes: 0,
      commits: 0,
      files: 0,
      additions: 0,
      deletions: 0,
      prsMerged: 0,
    };
    if (e.type === 'git.push') {
      row.pushes += 1;
      row.commits += e.commits;
      row.files += e.files;
      row.additions += e.additions;
      row.deletions += e.deletions;
    } else {
      row.prsMerged += 1;
    }
    shippedMap.set(key, row);
  }

  const boxRuns: ContribBoxRun[] = src.boxRuns
    .filter((r) => idOk(r.boxId) && r.end > from && r.start < to && r.end > r.start)
    .map((r) => ({ boxId: r.boxId, provider: r.provider, start: r.start, end: r.end }));

  const used = new Set<string>();
  for (const i of intervals) if (i.boxId) used.add(i.boxId);
  for (const t of tokenMap.values()) if (t.boxId) used.add(t.boxId);
  for (const s of shippedMap.values()) if (s.boxId) used.add(s.boxId);
  for (const r of boxRuns) used.add(r.boxId);
  const boxes: ContribBox[] = src.boxes
    .filter((b) => used.has(b.boxId))
    .map((b) => ({
      boxId: b.boxId,
      agent: b.agent,
      provider: b.provider,
      ...(idOk(b.managerId) ? { managerId: b.managerId } : {}),
    }));

  return {
    v: 1,
    machineId: opts.machineId,
    window: { since: opts.since, until: opts.until },
    tz,
    intervals,
    tokens: [...tokenMap.values()],
    shipped: [...shippedMap.values()],
    boxes,
    boxRuns,
  };
}

// ── the control box side: one stored contribution per machine ──

/**
 * Replace what `prev` holds for `next`'s window with `next`. Intervals and box runs
 * overlapping the window go, days inside it go; the rest of `prev` stays, so a
 * short periodic push keeps the year an earlier full push sent. A zone change
 * replaces everything (stored days would mean different hours). Rows older than
 * `keepSinceMs` are dropped.
 */
export function mergeContribution(
  prev: UsageContribution | null,
  next: UsageContribution,
  keepSinceMs: number,
): UsageContribution {
  if (!prev || prev.tz !== next.tz) return next;
  const tz = next.tz;
  const from = dayStart(next.window.since, tz);
  const to = dayStart(addDays(next.window.until, 1), tz);
  const keepDay = dayKey(keepSinceMs, tz);
  const outside = (start: number, end: number): boolean =>
    (end <= from || start >= to) && end > keepSinceMs;
  const dayOutside = (d: string): boolean =>
    (d < next.window.since || d > next.window.until) && d >= keepDay;

  const intervals = [...prev.intervals.filter((i) => outside(i.start, i.end)), ...next.intervals];
  const tokens = [...prev.tokens.filter((t) => dayOutside(t.day)), ...next.tokens];
  const shipped = [...prev.shipped.filter((s) => dayOutside(s.day)), ...next.shipped];
  const boxRuns = [...prev.boxRuns.filter((r) => outside(r.start, r.end)), ...next.boxRuns];
  const used = new Set<string>();
  for (const i of intervals) if (i.boxId) used.add(i.boxId);
  for (const t of tokens) if (t.boxId) used.add(t.boxId);
  for (const s of shipped) if (s.boxId) used.add(s.boxId);
  for (const r of boxRuns) used.add(r.boxId);
  const boxes = new Map<string, ContribBox>();
  for (const b of [...prev.boxes, ...next.boxes]) if (used.has(b.boxId)) boxes.set(b.boxId, b);
  const since = prev.window.since < next.window.since ? prev.window.since : next.window.since;
  const until = prev.window.until > next.window.until ? prev.window.until : next.window.until;
  return {
    v: 1,
    machineId: next.machineId,
    window: { since: since < keepDay ? keepDay : since, until },
    tz,
    intervals: intervals.slice(-CONTRIBUTION_LIMITS.intervals),
    tokens: tokens.slice(-CONTRIBUTION_LIMITS.tokens),
    shipped: shipped.slice(-CONTRIBUTION_LIMITS.shipped),
    boxes: [...boxes.values()].slice(-CONTRIBUTION_LIMITS.boxes),
    boxRuns: boxRuns.slice(-CONTRIBUTION_LIMITS.boxRuns),
  };
}

/**
 * What the reading hub's own rows already cover, per kind, so a contribution never
 * counts them twice. Per kind because a hub can hold one kind of row for a box
 * whose others live on the PC (a workspace PR sync records a PC box's merges on the
 * control box; its sessions and pushes stay on the PC).
 */
export interface OwnUsageKeys {
  /** Boxes whose sessions (intervals, tokens) the hub holds. */
  sessionBoxIds: ReadonlySet<string>;
  /** Host sessions the hub holds (a PC that ships its host sessions here). */
  sessionIds: ReadonlySet<string>;
  /** Boxes with `git.push` rows in the hub's ledger. */
  pushBoxIds: ReadonlySet<string>;
  /** Boxes with `pr.merged` rows in the hub's ledger. */
  prBoxIds: ReadonlySet<string>;
  /** Boxes with lifecycle rows (box-hours) in the hub's ledger. */
  runBoxIds: ReadonlySet<string>;
}

/**
 * A stored contribution as `buildUsageStats` input rows for the read
 * `[fromMs, toMs)`. A kind of row the hub holds itself for that box (or host
 * session) is left out: its own rows are the full record. A day's tokens and
 * shipped counts land at noon of that day in the contribution's zone.
 */
export function contributionRows(
  c: UsageContribution,
  own: OwnUsageKeys,
  fromMs: number,
  toMs: number,
): ContributionSource {
  const not = (set: ReadonlySet<string>, boxId: string | null): boolean =>
    boxId === null || !set.has(boxId);
  const noon = (day: string): number => dayStart(day, c.tz) + 12 * 3_600_000;
  const boxInfo = new Map<string, ContribBox>();
  for (const b of c.boxes) boxInfo.set(b.boxId, b);

  const lanes = new Map<string, SessionTurns>();
  for (const i of c.intervals) {
    if (!not(own.sessionBoxIds, i.boxId)) continue;
    if (i.boxId === null && own.sessionIds.has(i.sessionId!)) continue;
    if (i.end <= fromMs || i.start >= toMs) continue;
    // One lane per box, as the hub's own box sessions are unioned; host sessions one each.
    const key = i.boxId ?? `host:${i.sessionId!}`;
    let lane = lanes.get(key);
    if (!lane) {
      const box = i.boxId ? boxInfo.get(i.boxId) : undefined;
      lane = {
        sessionId: `${c.machineId}:${key}`,
        boxId: i.boxId,
        agent: i.agent,
        provider: i.provider,
        managerId: box?.managerId ?? null,
        turns: [],
        spans: [],
      };
      lanes.set(key, lane);
    }
    lane.spans!.push({ start: i.start, end: i.end });
  }

  const tokens: TokenRow[] = [];
  for (const t of c.tokens) {
    if (!not(own.sessionBoxIds, t.boxId)) continue;
    const at = noon(t.day);
    if (at < fromMs || at >= toMs) continue;
    tokens.push({ at, agent: t.agent, provider: t.provider, boxId: t.boxId, tokens: t.tokens });
  }

  const events: ActivityEvent[] = [];
  for (const s of c.shipped) {
    const at = noon(s.day);
    if (at < fromMs || at >= toMs) continue;
    if ((s.pushes > 0 || s.commits > 0) && not(own.pushBoxIds, s.boxId)) {
      events.push({
        type: 'git.push',
        at,
        boxId: s.boxId,
        commits: s.commits,
        files: s.files,
        additions: s.additions,
        deletions: s.deletions,
      });
    }
    // Bounded by the schema's count cap per row; a day's merges are rarely more than tens.
    const prs = not(own.prBoxIds, s.boxId) ? Math.min(s.prsMerged, 10_000) : 0;
    for (let n = 0; n < prs; n++) {
      events.push({ type: 'pr.merged', at, boxId: s.boxId });
    }
  }

  const boxRuns: BoxRun[] = c.boxRuns
    .filter((r) => not(own.runBoxIds, r.boxId) && r.end > fromMs && r.start < toMs)
    .map((r) => ({ ...r }));

  const boxes: BoxInfo[] = [...boxInfo.values()].map((b) => ({
    boxId: b.boxId,
    // The name stays on the PC: the box reads by its id here.
    name: b.boxId,
    agent: b.agent as Agent,
    provider: b.provider,
    ...(b.managerId ? { managerId: b.managerId } : {}),
  }));

  return { sessions: [...lanes.values()], tokens, events, boxes, boxRuns };
}
