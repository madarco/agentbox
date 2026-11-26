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
/** A local calendar day, `YYYY-MM-DD`. */
const day = z.iso.date();
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

export const DailyShare = z.strictObject(dailyCore);
export const DailyStats = z.strictObject({
  ...dailyCore,
  byProject: z.record(name, SplitValues).optional(),
});
export type DailyShare = z.infer<typeof DailyShare>;
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

const laneCore = {
  agent: AgentId,
  provider: ProviderId,
  intervals: z.array(Interval).min(1).max(LIMITS.intervalsPerLane),
};
export const LaneShare = z.strictObject({ ...laneCore, merged: z.boolean() });
export const LaneStats = z.strictObject({
  ...laneCore,
  box: name,
  /** `repo#123` of the PR merged at the end of the lane. */
  pr: name.nullable(),
});
export type LaneShare = z.infer<typeof LaneShare>;
export type LaneStats = z.infer<typeof LaneStats>;

export const GanttDayShare = z.strictObject({
  date: day,
  lanes: z.array(LaneShare).max(LIMITS.lanes),
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
export const SessionShare = z.strictObject(sessionCore);
export const SessionStats = z.strictObject({
  ...sessionCore,
  title: name,
  project: name.nullable(),
});
export type SessionShare = z.infer<typeof SessionShare>;
export type SessionStats = z.infer<typeof SessionStats>;

/** Agent-hours by weekday (0 = Sunday) and hour of day, local time. */
export const Punchcard = z.array(z.array(hours).length(24)).length(7);

const providerCore = { id: ProviderId, hours: hours, boxes: count };
export const ProviderShare = z.strictObject(providerCore);
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

export const UsageRange = z.strictObject({
  id: RangeId,
  since: day,
  until: day,
  /** The last day with data; days after it up to `until` are forecast. */
  today: day,
  /** Local time minus UTC, in minutes (CET is 60). Days are bucketed with it. */
  tzOffset: z
    .number()
    .int()
    .min(-14 * 60)
    .max(14 * 60),
});
export type UsageRange = z.infer<typeof UsageRange>;

const coreShape = {
  version: z.literal(1),
  range: UsageRange,
  hero: Hero,
  kpis: Kpis,
  wall: z.array(WallDay).max(LIMITS.wallDays),
  streaks: Streaks,
  punchcard: Punchcard,
};

export const UsageShare = z.strictObject({
  ...coreShape,
  handle: z.string().regex(HANDLE_RE),
  daily: z.array(DailyShare).max(LIMITS.dailyDays),
  gantt: z.array(GanttDayShare).max(LIMITS.ganttDays),
  sessions: z.array(SessionShare).max(LIMITS.sessions),
  providers: z.array(ProviderShare).max(PROVIDER_IDS.length),
});
export type UsageShare = z.infer<typeof UsageShare>;

export const UsageStats = z.strictObject({
  ...coreShape,
  generatedAt: z.iso.datetime({ offset: true }),
  daily: z.array(DailyStats).max(LIMITS.dailyDays),
  gantt: z.array(GanttDayStats).max(LIMITS.ganttDays),
  sessions: z.array(SessionStats).max(LIMITS.sessions),
  providers: z.array(ProviderStats).max(PROVIDER_IDS.length),
  feed: z.array(FeedItem).max(LIMITS.feed),
  /** Total merged PRs behind the feed ("All 47"). */
  feedTotal: count,
  boxes: z.array(BoxRow).max(LIMITS.boxes),
  projects: z.array(ProjectRow).max(LIMITS.projects),
  subscriptions: z.array(SubscriptionRow).max(LIMITS.subscriptions),
});
export type UsageStats = z.infer<typeof UsageStats>;
