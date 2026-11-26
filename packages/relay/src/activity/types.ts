// The activity ledger (docs/usage-dashboard-plan.md, Phase 1): one row per box
// lifecycle step, push and PR state, for every box this hub owns, in a
// workspace or not. The usage dashboard counts box-hours, commits, lines and
// PRs off it; the workspace timeline stays the per-workspace story.

export const ACTIVITY_TYPES = [
  'box.created',
  'box.ready',
  'box.failed',
  'box.started',
  'box.stopped',
  'box.paused',
  'box.resumed',
  'box.destroyed',
  'git.push',
  'pr.opened',
  'pr.ready',
  'pr.merged',
  'pr.closed',
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export function isActivityType(s: string): s is ActivityType {
  return (ACTIVITY_TYPES as readonly string[]).includes(s);
}

/** Who caused the row. `autopause` is the relay's idle loops; the rest match the timeline's actors. */
export type ActivityActor = 'human' | 'manager' | 'box' | 'hub' | 'github' | 'autopause';

export interface ActivityPr {
  /** `owner/name`. */
  repo: string;
  number: number;
  url?: string;
}

export interface ActivityEvent {
  /**
   * The dedupe key. A source event that has one (a create job, a PR state, a
   * box-reported push tip) reuses the workspace timeline's key, so the live
   * write, the timeline backfill and a retried report land as one row.
   */
  id: string;
  type: ActivityType;
  /** ISO-8601. */
  at: string;
  actor?: ActivityActor;
  boxId?: string;
  boxName?: string;
  provider?: string;
  agent?: string;
  /** `agent/account`, the subscription the box's agent runs on. */
  account?: string;
  repoUrl?: string;
  /** `repoKey(repoUrl)`: `host/owner/name`, the grouping key for a project. */
  projectKey?: string;
  workspaceId?: string;
  managerId?: string;
  /** The create job, which is all a `box.created` row knows the box by. */
  jobId?: string;
  branch?: string;
  /** `git.push`. */
  commits?: number;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  /** `git.push`: a host-only landing, which publishes nothing. */
  hostOnly?: boolean;
  pr?: ActivityPr;
  /** `backfill` rows came from a workspace timeline and carry less (no provider, no account). */
  source: 'live' | 'backfill';
}

export type ActivityInput = Omit<ActivityEvent, 'id' | 'at' | 'source' | 'projectKey'> & {
  id?: string;
  at?: string;
};

export interface ActivityQuery {
  /** Inclusive, epoch ms. */
  sinceMs?: number;
  /** Exclusive, epoch ms. */
  untilMs?: number;
  types?: readonly ActivityType[];
  boxId?: string;
  /** Default 1000, capped at 50 000. */
  limit?: number;
  /** `desc` takes the newest `limit` rows (still returned oldest first). Default `asc`. */
  order?: 'asc' | 'desc';
}

export const ACTIVITY_QUERY_MAX = 50_000;

export interface ActivityStore {
  readonly kind: 'sqlite' | 'postgres';
  /** Create the tables if absent and stamp `created_at` once. Idempotent. */
  migrate(): Promise<void>;
  /** Insert the rows whose id is new; returns how many were. One transaction. */
  append(events: readonly ActivityEvent[]): Promise<number>;
  /** Oldest first. */
  list(query?: ActivityQuery): Promise<ActivityEvent[]>;
  /** Which of these ids the ledger already holds. */
  has(ids: readonly string[]): Promise<Set<string>>;
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
  close(): Promise<void>;
}
