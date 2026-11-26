import { z } from 'zod';

export const AGENT_IDS = ['claude', 'codex', 'opencode', 'pi', 'openclaw', 'other'] as const;
export const PROVIDER_IDS = [
  'docker',
  'hetzner',
  'daytona',
  'vercel',
  'e2b',
  'remote-docker',
  'digitalocean',
  'host',
  'other',
] as const;
export const RANGE_IDS = ['7d', 'month', '90d', 'year'] as const;

export const AgentId = z.enum(AGENT_IDS);
export const ProviderId = z.enum(PROVIDER_IDS);
export const RangeId = z.enum(RANGE_IDS);
export type AgentId = z.infer<typeof AgentId>;
export type ProviderId = z.infer<typeof ProviderId>;
export type RangeId = z.infer<typeof RangeId>;

export const HANDLE_RE = /^[a-z0-9-]{1,39}$/;

/** Upper bounds. Generous for one person, tight enough that a share stays small. */
export const LIMITS = {
  dailyDays: 400,
  /** Longest window: a year plus a leap day. */
  rangeDays: 367,
  wallDays: 371,
  ganttDays: 7,
  lanes: 64,
  intervalsPerLane: 48,
  sessions: 20,
  feed: 20,
  boxes: 20,
  projects: 20,
  subscriptions: 20,
  name: 200,
} as const;

/**
 * The public share's own, tighter bounds: with every array full and every number at
 * its longest, a share still serializes under `SHARE_MAX_BYTES` (tested). The share
 * keeps the last two months of the daily chart and the three Gantt days the page shows.
 */
export const SHARE_LIMITS = {
  dailyDays: 62,
  ganttDays: 3,
  lanes: 16,
  intervalsPerLane: 8,
  sessions: 10,
} as const;
export const SHARE_MAX_BYTES = 64 * 1024;

const MIN_DAY = '2020-01-01';
const MAX_DAY = '2100-12-31';

const MAX_COUNT = 1e7;
const MAX_HOURS = 1e6;
const MAX_TOKENS = 1e13;
const MAX_LINES = 1e9;

const count = z.number().int().min(0).max(MAX_COUNT);
const hours = z.number().min(0).max(MAX_HOURS);
const tokens = z.number().min(0).max(MAX_TOKENS);
const lines = z.number().int().min(0).max(MAX_LINES);
const ratio = z.number().min(0).max(1000);
const signedDelta = z.number().min(-MAX_TOKENS).max(MAX_TOKENS);
/** A local calendar day, `YYYY-MM-DD`, between 2020 and 2100. */
const day = z.iso
  .date()
  .refine((d) => d >= MIN_DAY && d <= MAX_DAY, { message: 'date outside 2020-2100' });
const daySpan = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);
const name = z.string().min(1).max(LIMITS.name);
/** Hours since the local midnight of the lane's day; past 24 runs into the next day. */
const hourOfDay = z.number().min(-24).max(48);

export const Interval = z
  .tuple([hourOfDay, hourOfDay])
  .refine(([a, b]) => b >= a, { message: 'interval end before start' });

/** One bucket of a split (per agent, per provider, per project). */
export const SplitValues = z.strictObject({
  tokens: tokens,
  agentHours: hours,
  commits: count,
});
export type SplitValues = z.infer<typeof SplitValues>;

const dailyCore = {
  date: day,
  tokens: tokens,
  agentHours: hours,
  wallHours: hours,
  boxHours: hours,
  /** Most boxes active at the same moment that day. */
  peak: count,
  /** agentHours / wallHours: how many ran together on average while any ran. */
  avgAtOnce: ratio,
  commits: count,
  prsMerged: count,
  additions: lines,
  deletions: lines,
  files: count,
  byAgent: z.partialRecord(AgentId, SplitValues),
  byProvider: z.partialRecord(ProviderId, SplitValues),
};

export const DailyStats = z.strictObject({
  ...dailyCore,
  byProject: z.record(name, SplitValues).optional(),
});
export type DailyStats = z.infer<typeof DailyStats>;

export const WallDay = z.strictObject({
  date: day,
  /** Commits + merged PRs: the "all work" ramp. */
  all: count,
  peak: count,
  commits: count,
  prs: count,
  agentHours: hours,
  tokens: tokens,
});
export type WallDay = z.infer<typeof WallDay>;

// Share numbers. Hours carry at most one decimal (6 minutes), so no number can
// serialize as a 17-digit float; toShare rounds to it.
const oneDecimal = (v: number): boolean => Number(v.toFixed(1)) === v;
const sHours = (max: number) =>
  z.number().min(0).max(max).refine(oneDecimal, { message: 'more than one decimal' });
const sInt = (max: number) => z.number().int().min(0).max(max);
/** Per day: tokens, hours, counts and lines one person's boxes can plausibly reach. */
const S = {
  tokens: sInt(1e10),
  hours: sHours(2000),
  count: sInt(99_999),
  lines: sInt(9_999_999),
  peak: sInt(999),
  ratio: sHours(999),
};

// A share stores the daily rows and the wall column by column (one array per metric,
// day i is `start` + i): a year of rows is several times the 64 KB a share may weigh.
const lengthsMatch = (arrays: readonly (readonly unknown[])[]): boolean =>
  arrays.every((a) => a.length === arrays[0]!.length);
const splitArrays = (
  s: Record<string, { tokens: number[]; agentHours: number[]; commits: number[] } | undefined>,
) => Object.values(s).flatMap((v) => (v ? [v.tokens, v.agentHours, v.commits] : []));

const dcol = <T extends z.ZodType>(t: T) => z.array(t).max(SHARE_LIMITS.dailyDays);
export const SplitColumns = z.strictObject({
  tokens: dcol(S.tokens),
  agentHours: dcol(S.hours),
  commits: dcol(S.count),
});
export const DailyColumns = z
  .strictObject({
    start: day,
    tokens: dcol(S.tokens),
    agentHours: dcol(S.hours),
    wallHours: dcol(S.hours),
    boxHours: dcol(S.hours),
    peak: dcol(S.peak),
    avgAtOnce: dcol(S.ratio),
    commits: dcol(S.count),
    prsMerged: dcol(S.count),
    additions: dcol(S.lines),
    deletions: dcol(S.lines),
    files: dcol(S.count),
    byAgent: z.partialRecord(AgentId, SplitColumns),
    byProvider: z.partialRecord(ProviderId, SplitColumns),
  })
  .refine(
    (d) =>
      lengthsMatch([
        d.tokens,
        d.agentHours,
        d.wallHours,
        d.boxHours,
        d.peak,
        d.avgAtOnce,
        d.commits,
        d.prsMerged,
        d.additions,
        d.deletions,
        d.files,
        ...splitArrays(d.byAgent),
        ...splitArrays(d.byProvider),
      ]),
    { message: 'daily columns differ in length' },
  );
export type DailyColumns = z.infer<typeof DailyColumns>;

const wcol = <T extends z.ZodType>(t: T) => z.array(t).max(LIMITS.wallDays);
export const WallColumns = z
  .strictObject({
    start: day,
    all: wcol(S.count),
    peak: wcol(S.peak),
    commits: wcol(S.count),
    prs: wcol(S.count),
    agentHours: wcol(S.hours),
    tokens: wcol(S.tokens),
  })
  .refine((w) => lengthsMatch([w.all, w.peak, w.commits, w.prs, w.agentHours, w.tokens]), {
    message: 'wall columns differ in length',
  });
export type WallColumns = z.infer<typeof WallColumns>;

export const Hero = z.strictObject({
  agentHours: hours,
  wallHours: hours,
  speedup: ratio,
  peakAtOnce: count,
  peakDate: day.nullable(),
  /** Hours on the clock with two or more boxes active. */
  parallelHours: hours,
  maxPrsInSession: count,
  sessionsWith3Plus: count,
  streakDays: count,
  prsMerged: count,
  commits: count,
  additions: lines,
  deletions: lines,
  files: count,
  boxes: count,
  bestDayPrs: count,
  bestDayCommits: count,
  biggestPrAdditions: lines,
});
export type Hero = z.infer<typeof Hero>;

/** Change against the previous window of the same length; null when there is none. */
const delta = signedDelta.nullable();

export const Kpis = z.strictObject({
  peak: z.strictObject({ value: count, delta, runningNow: count }),
  speedup: z.strictObject({ value: ratio, delta }),
  /** `hoursSaved(hero)`, with its change. Optional: shares made before it lack it. */
  hoursSaved: z.strictObject({ value: hours, delta }).optional(),
  prs: z.strictObject({ value: count, delta, waitingReview: count }),
  boxHours: z.strictObject({ value: hours, deltaPct: delta, boxes: count, tokens: tokens }),
});
export type Kpis = z.infer<typeof Kpis>;

export const Streaks = z.strictObject({
  current: count,
  best: count,
  activeDays: count,
  daysSinceFirst: count,
  firstDate: day.nullable(),
  /** 0 = Sunday. */
  busiestWeekday: z.number().int().min(0).max(6).nullable(),
  busiestWeekdayShare: z.number().min(0).max(1),
  bestDay: z.strictObject({ date: day, commits: count }).nullable(),
});
export type Streaks = z.infer<typeof Streaks>;

export const LaneShare = z.strictObject({
  agent: AgentId,
  provider: ProviderId,
  intervals: z
    .array(
      z
        .tuple([sHours(48), sHours(48)])
        .refine(([a, b]) => b >= a, { message: 'interval end before start' }),
    )
    .min(1)
    .max(SHARE_LIMITS.intervalsPerLane),
  merged: z.boolean(),
});
export const LaneStats = z.strictObject({
  agent: AgentId,
  provider: ProviderId,
  intervals: z.array(Interval).min(1).max(LIMITS.intervalsPerLane),
  box: name,
  /** `repo#123` of the PR merged at the end of the lane. */
  pr: name.nullable(),
});
export type LaneShare = z.infer<typeof LaneShare>;
export type LaneStats = z.infer<typeof LaneStats>;

export const GanttDayShare = z.strictObject({
  date: day,
  lanes: z.array(LaneShare).max(SHARE_LIMITS.lanes),
});
export const GanttDayStats = z.strictObject({
  date: day,
  lanes: z.array(LaneStats).max(LIMITS.lanes),
});
export type GanttDayShare = z.infer<typeof GanttDayShare>;
export type GanttDayStats = z.infer<typeof GanttDayStats>;

const sessionCore = {
  /** The agent and provider most of the session's boxes ran. */
  agent: AgentId,
  provider: ProviderId,
  boxes: count,
  peak: count,
  prsMerged: count,
  minutes: z
    .number()
    .min(0)
    .max(MAX_HOURS * 60),
};
export const SessionShare = z.strictObject({
  ...sessionCore,
  boxes: sInt(99_999),
  peak: S.peak,
  prsMerged: S.count,
  minutes: sInt(9_999_999),
});
export const SessionStats = z.strictObject({
  ...sessionCore,
  title: name,
  project: name.nullable(),
});
export type SessionShare = z.infer<typeof SessionShare>;
export type SessionStats = z.infer<typeof SessionStats>;

/** Agent-hours by weekday (0 = Sunday) and hour of day, local time. */
export const Punchcard = z.array(z.array(hours).length(24)).length(7);
const PunchcardShare = z.array(z.array(sHours(99_999)).length(24)).length(7);

const providerCore = { id: ProviderId, hours: hours, boxes: count };
export const ProviderShare = z.strictObject({
  id: ProviderId,
  hours: sHours(999_999),
  boxes: sInt(99_999),
});
export const ProviderStats = z.strictObject({ ...providerCore, note: name.nullable() });
export type ProviderShare = z.infer<typeof ProviderShare>;
export type ProviderStats = z.infer<typeof ProviderStats>;

export const FeedItem = z.strictObject({
  title: name,
  repo: name,
  number: z.number().int().min(1).max(1e9),
  box: name,
  agent: AgentId,
  provider: ProviderId,
  additions: lines,
  deletions: lines,
  mergedAt: z.iso.datetime({ offset: true }),
});
export type FeedItem = z.infer<typeof FeedItem>;

export const BoxRow = z.strictObject({
  name: name,
  project: name.nullable(),
  agent: AgentId,
  provider: ProviderId,
  hours: hours,
  tokens: tokens,
  prs: count,
  additions: lines,
  deletions: lines,
});
export type BoxRow = z.infer<typeof BoxRow>;

export const ProjectRow = z.strictObject({
  name: name,
  prs: count,
  commits: count,
  additions: lines,
});
export type ProjectRow = z.infer<typeof ProjectRow>;

export const SubscriptionRow = z.strictObject({
  agent: AgentId,
  label: name,
  tokens: tokens,
  /** USD, null when the plan includes it. */
  cost: z.number().min(0).max(1e9).nullable(),
});
export type SubscriptionRow = z.infer<typeof SubscriptionRow>;

/** Longest zone name accepted; the IANA list's longest is about 30. */
export const TZ_MAX_LENGTH = 64;
const zoneList = (): ReadonlySet<string> => {
  const set = new Set(Intl.supportedValuesOf('timeZone'));
  // Node lists neither `UTC` nor the fixed-offset `Etc/GMT±N` zones (a container's
  // TZ often is one); both are a closed set of their own.
  set.add('UTC');
  for (let h = 1; h <= 14; h++) {
    set.add(`Etc/GMT-${String(h)}`);
    if (h <= 12) set.add(`Etc/GMT+${String(h)}`);
  }
  return set;
};
let zones: ReadonlySet<string> | null = null;

/**
 * Whether `tz` is a zone name this runtime's `Intl` lists: a closed set, so a share's
 * only zone string can never carry free text.
 */
export function isTimeZone(tz: string): boolean {
  if (tz.length === 0 || tz.length > TZ_MAX_LENGTH) return false;
  zones ??= zoneList();
  return zones.has(tz);
}

/**
 * The runtime's canonical spelling of a zone `Intl` accepts (`utc` is `UTC`, and an
 * alias such as `Asia/Kolkata` may come back as `Asia/Calcutta`); null for anything else.
 */
export function canonicalTimeZone(raw: string): string | null {
  if (raw.length === 0 || raw.length > TZ_MAX_LENGTH) return null;
  try {
    const tz = new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
    return isTimeZone(tz) ? tz : null;
  } catch {
    return null;
  }
}

export const TimeZone = z
  .string()
  .max(TZ_MAX_LENGTH)
  .refine(isTimeZone, { message: 'unknown time zone' });

export const UsageRange = z
  .strictObject({
    id: RangeId,
    since: day,
    until: day,
    /** The last day with data; days after it up to `until` are forecast. */
    today: day,
    /** The IANA time zone days are bucketed in (`Europe/Rome`). */
    tz: TimeZone,
  })
  .refine((r) => r.since <= r.today && r.today <= r.until, {
    message: 'range must satisfy since <= today <= until',
  })
  .refine((r) => daySpan(r.since, r.until) < LIMITS.rangeDays, {
    message: `range longer than ${LIMITS.rangeDays} days`,
  });
export type UsageRange = z.infer<typeof UsageRange>;

const unique = (xs: readonly string[]): boolean => new Set(xs).size === xs.length;
/** An array whose items must not repeat `key`: React keys rows by it. */
const unq = <T extends z.ZodType>(
  arr: z.ZodArray<T>,
  key: (t: z.infer<T>) => string,
  what: string,
) => arr.refine((xs) => unique(xs.map(key)), { message: `duplicate ${what}` });

const coreShape = {
  version: z.literal(1),
  range: UsageRange,
  hero: Hero,
  kpis: Kpis,
  streaks: Streaks,
};

export const UsageShare = z.strictObject({
  ...coreShape,
  handle: z.string().regex(HANDLE_RE),
  punchcard: PunchcardShare,
  daily: DailyColumns,
  wall: WallColumns,
  gantt: unq(z.array(GanttDayShare).max(SHARE_LIMITS.ganttDays), (g) => g.date, 'Gantt day'),
  sessions: z.array(SessionShare).max(SHARE_LIMITS.sessions),
  providers: unq(z.array(ProviderShare).max(PROVIDER_IDS.length), (p) => p.id, 'provider'),
});
export type UsageShare = z.infer<typeof UsageShare>;

export const UsageStats = z.strictObject({
  ...coreShape,
  generatedAt: z.iso.datetime({ offset: true }),
  punchcard: Punchcard,
  daily: unq(z.array(DailyStats).max(LIMITS.dailyDays), (d) => d.date, 'daily date'),
  wall: unq(z.array(WallDay).max(LIMITS.wallDays), (w) => w.date, 'wall date'),
  gantt: unq(z.array(GanttDayStats).max(LIMITS.ganttDays), (g) => g.date, 'Gantt day'),
  sessions: z.array(SessionStats).max(LIMITS.sessions),
  providers: unq(z.array(ProviderStats).max(PROVIDER_IDS.length), (p) => p.id, 'provider'),
  feed: z.array(FeedItem).max(LIMITS.feed),
  /** Total merged PRs behind the feed ("All 47"). */
  feedTotal: count,
  boxes: z.array(BoxRow).max(LIMITS.boxes),
  projects: z.array(ProjectRow).max(LIMITS.projects),
  subscriptions: z.array(SubscriptionRow).max(LIMITS.subscriptions),
});
export type UsageStats = z.infer<typeof UsageStats>;
