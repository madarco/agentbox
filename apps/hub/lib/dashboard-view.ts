// Pure helpers of the hub Dashboard (docs/hub-redesign-plan.md): the day's
// lanes and the running-at-once series from the activity ledger
// (`GET /api/v1/activity`), the recent-activity feed, and the week's numbers
// from `GET /api/v1/usage/stats`. No React, so they are unit-tested alone.

import type { UsageStats } from '@agentbox/usage-view';

/** The ledger row fields the Dashboard reads (`ActivityEvent` in @agentbox/relay). */
export interface DashActivity {
  id: string;
  type: string;
  at: string;
  boxId?: string;
  boxName?: string;
  /** The create job, all a `box.created` row knows the box by. */
  jobId?: string;
  agent?: string;
  branch?: string;
  commits?: number;
  additions?: number;
  deletions?: number;
  hostOnly?: boolean;
  pr?: { repo: string; number: number; url?: string };
}

/** What the lanes need to know about a live box. */
export interface DashBox {
  id: string;
  name?: string;
  task: string;
  agent: string;
  status: string;
  lastActivity: number;
}

export type SegKind = 'running' | 'paused';

export interface Lane {
  /** The box id when the ledger row names one, else its name. */
  key: string;
  box?: DashBox;
  label: string;
  agent?: string;
  /** Hours ago, `[from, to]` with from >= to (to = 0 is now). */
  segs: Array<[number, number, SegKind]>;
  /** Hours ago of each push. */
  pushes: number[];
  /** Hours ago of each merged PR. */
  merges: number[];
  /** Hours ago of a failed create, if any. */
  failed?: number;
  /** Epoch ms of the lane's newest row, for ordering. */
  last: number;
}

const HOUR = 3_600_000;
const RUN_START = new Set(['box.ready', 'box.started', 'box.resumed']);
const RUN_END = new Set(['box.stopped', 'box.destroyed', 'box.failed']);

/**
 * One lane per box with something inside the last `span` hours: running and
 * paused stretches (from the lifecycle rows), pushes and merged PRs. Rows from
 * before the window only set the state the window opens in, so `events` should
 * reach further back than `span` (the caller asks for 48 h). Newest lane first.
 */
export function buildLanes(
  events: readonly DashActivity[],
  boxes: readonly DashBox[],
  now: number,
  span = 12,
): Lane[] {
  const start = now - span * HOUR;
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const byName = new Map(boxes.filter((b) => b.name).map((b) => [b.name!, b]));
  const ago = (ms: number) => Math.max(0, Math.min(span, (now - ms) / HOUR));

  // A create row knows the box only by its job (and name); the later rows of a
  // create that succeeded carry the box id too. A failed create keeps its own
  // `job:<id>` key, which is also the synthetic box row the store shows for it,
  // so a retry under the same name does not inherit the failure.
  const jobToId = new Map<string, string>();
  for (const e of events) if (e.boxId && e.jobId) jobToId.set(e.jobId, e.boxId);
  const nameToId = new Map<string, string>();
  for (const e of events) if (e.boxId && e.boxName) nameToId.set(e.boxName, e.boxId);
  const keyOf = (e: DashActivity): string | undefined => {
    if (e.boxId) return e.boxId;
    if (e.jobId) return jobToId.get(e.jobId) ?? `job:${e.jobId}`;
    if (e.boxName) return nameToId.get(e.boxName) ?? byName.get(e.boxName)?.id ?? `name:${e.boxName}`;
    return undefined;
  };
  const groups = new Map<string, DashActivity[]>();
  for (const e of [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const key = keyOf(e);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }

  const lanes: Lane[] = [];
  for (const [key, rows] of groups) {
    const box = byId.get(key) ?? (key.startsWith('name:') ? byName.get(key.slice(5)) : undefined);
    const lane: Lane = {
      key,
      box,
      label: box?.task ?? rows[rows.length - 1]!.boxName ?? key,
      agent: box?.agent ?? rows.find((r) => r.agent)?.agent,
      segs: [],
      pushes: [],
      merges: [],
      last: Date.parse(rows[rows.length - 1]!.at),
    };
    let state: SegKind | null = null;
    let since = start;
    const close = (at: number) => {
      if (state && at > start) lane.segs.push([ago(Math.max(since, start)), ago(at), state]);
    };
    for (const r of rows) {
      const t = Date.parse(r.at);
      if (Number.isNaN(t) || t > now) continue;
      let next: SegKind | null | undefined;
      if (RUN_START.has(r.type)) next = 'running';
      else if (r.type === 'box.paused') next = 'paused';
      else if (RUN_END.has(r.type)) next = null;
      if (next !== undefined && next !== state) {
        close(t);
        state = next;
        since = t;
      }
      if (t < start) continue;
      if (r.type === 'git.push') lane.pushes.push(ago(t));
      else if (r.type === 'pr.merged') lane.merges.push(ago(t));
      else if (r.type === 'box.failed') lane.failed = ago(t);
    }
    if (state) {
      // An open stretch runs to now only while the store agrees; a row the
      // ledger missed (the box stopped outside the hub) ends it at the box's
      // last activity instead of drawing it to now.
      const live = box ? box.status === state : false;
      const end = live ? now : Math.max(since, box?.lastActivity ?? since);
      close(Math.min(end, now));
    }
    if (lane.segs.length || lane.pushes.length || lane.merges.length || lane.failed !== undefined) {
      lanes.push(lane);
    }
  }
  return lanes.sort((a, b) => b.last - a.last);
}

/** Boxes running at once, sampled every `stepMin` minutes over the lanes' span (oldest first). */
export function runningAtOnce(lanes: readonly Lane[], span = 12, stepMin = 10): number[] {
  const out: number[] = [];
  const step = stepMin / 60;
  for (let t = span; t >= -1e-9; t -= step) {
    out.push(
      lanes.reduce(
        (n, l) => n + (l.segs.some(([f, e, k]) => k === 'running' && t <= f && t >= e) ? 1 : 0),
        0,
      ),
    );
  }
  return out;
}

export interface FeedEntry {
  id: string;
  kind: 'push' | 'pr' | 'merge' | 'ready' | 'failed' | 'lifecycle';
  text: string;
  meta: string;
  additions?: number;
  deletions?: number;
  boxId?: string;
  at: number;
}

const LIFECYCLE_TEXT: Record<string, string> = {
  'box.created': 'Box create started',
  'box.ready': 'Box ready',
  'box.failed': 'Box failed to start',
  'box.started': 'Box started',
  'box.stopped': 'Box stopped',
  'box.paused': 'Box paused',
  'box.resumed': 'Box resumed',
  'box.destroyed': 'Box destroyed',
};

const plural = (n: number, one: string) => `${String(n)} ${one}${n === 1 ? '' : 's'}`;

/** The newest ledger rows as feed lines, newest first. */
export function feedEntries(events: readonly DashActivity[], limit = 6): FeedEntry[] {
  const out: FeedEntry[] = [];
  const sorted = [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const e of sorted) {
    if (out.length >= limit) break;
    const who = e.boxName ?? e.boxId ?? '';
    const base = { id: e.id, boxId: e.boxId, at: Date.parse(e.at) };
    if (e.type === 'git.push') {
      const n = e.commits ?? 0;
      const where = e.branch ? ` to ${e.branch}` : '';
      out.push({
        ...base,
        kind: 'push',
        text: `${e.hostOnly ? 'Landed' : 'Pushed'} ${n > 0 ? plural(n, 'commit') : 'commits'}${where}`,
        meta: who,
        additions: e.additions,
        deletions: e.deletions,
      });
    } else if (e.type.startsWith('pr.') && e.pr) {
      const ref = `${e.pr.repo}#${String(e.pr.number)}`;
      const verb =
        e.type === 'pr.merged'
          ? 'Merged'
          : e.type === 'pr.closed'
            ? 'Closed'
            : e.type === 'pr.ready'
              ? 'Ready for review:'
              : 'Opened';
      out.push({
        ...base,
        kind: e.type === 'pr.merged' ? 'merge' : 'pr',
        text: `${verb} ${ref}`,
        meta: [who, e.branch].filter(Boolean).join(' · '),
      });
    } else if (LIFECYCLE_TEXT[e.type]) {
      out.push({
        ...base,
        kind: e.type === 'box.ready' ? 'ready' : e.type === 'box.failed' ? 'failed' : 'lifecycle',
        text: LIFECYCLE_TEXT[e.type]!,
        meta: who,
      });
    }
  }
  return out;
}

export interface WeekDay {
  date: string;
  /** Short weekday, `Mon`. */
  label: string;
  commits: number;
  prs: number;
  agentHours: number;
  wallHours: number;
  tokens: number;
  additions: number;
  deletions: number;
}

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The last `n` days ending on the stats' today, oldest first; a day with no row is zeros. */
export function lastDays(stats: Pick<UsageStats, 'daily' | 'range'>, n = 7): WeekDay[] {
  const rows = new Map(stats.daily.map((d) => [d.date, d]));
  const out: WeekDay[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = addDays(stats.range.today, -i);
    const d = rows.get(date);
    out.push({
      date,
      label: new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
        weekday: 'short',
        timeZone: 'UTC',
      }),
      commits: d?.commits ?? 0,
      prs: d?.prsMerged ?? 0,
      agentHours: d?.agentHours ?? 0,
      wallHours: d?.wallHours ?? 0,
      tokens: d?.tokens ?? 0,
      additions: d?.additions ?? 0,
      deletions: d?.deletions ?? 0,
    });
  }
  return out;
}

/** `+18%` / `−4%` from yesterday; null when yesterday had nothing to compare with. */
export function changePct(today: number, yesterday: number): string | null {
  if (yesterday <= 0) return null;
  const pct = Math.round(((today - yesterday) / yesterday) * 100);
  return `${pct >= 0 ? '+' : '−'}${String(Math.abs(pct))}%`;
}
