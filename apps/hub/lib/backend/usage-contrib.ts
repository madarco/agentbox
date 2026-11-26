// Usage contributions (docs/usage-dashboard-plan.md, Phase 4b): a PC's usage
// metrics reach the remote hub its CLI is configured with, its sessions never do.
//
//  - The control box keeps one contribution per machine id (`ContributionStore`),
//    written by `POST /api/v1/usage/contributions` and merged into its own
//    `/api/v1/usage/stats` (`addContributions` in usage-stats.ts).
//  - The PC's hub builds its contribution from the same rows its own stats use
//    (`buildContribution`) and pushes it (`createContributionPusher`): every few
//    minutes when it changed, and on demand (`POST /api/v1/usage/contributions/sync`,
//    which `agentbox usage` calls before it reads a remote hub).
//
// What leaves the PC is `UsageContribution` from `@agentbox/usage-view`: ids,
// enums, dates and numbers. `history.contributeUsage: false` turns the push off.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CONTRIBUTION_LIMITS,
  addDays,
  dayKey,
  dayStart,
  mergeContribution,
  toContribution,
  UsageContribution,
} from '@agentbox/usage-view';
import { clearUsageStatsCache, loadUsageRows, type UsageStatsDeps } from './usage-stats';

const DAY_MS = 86_400_000;
/** How far back a stored contribution keeps rows: a year view plus its previous window. */
const KEEP_DAYS = 400;
/** Distinct machines one hub takes contributions from. */
const MAX_MACHINES = 64;
const FILE_RE = /^[A-Za-z0-9._:-]{1,128}\.json$/;

export interface StoredContributionInfo {
  machineId: string;
  receivedAt: number;
  window: { since: string; until: string };
  tz: string;
  intervals: number;
  tokenRows: number;
  shippedRows: number;
  boxes: number;
  boxRuns: number;
}

interface StoredFile {
  receivedAt: number;
  contribution: UsageContribution;
}

/**
 * One JSON file per machine under `dir` (`~/.agentbox/hub/usage-contributions/`).
 * A push merges into the stored one (`mergeContribution`): its window replaces
 * what was stored for those days, the rest stays.
 */
export class ContributionStore {
  private chain: Promise<unknown> = Promise.resolve();
  private memo: { at: number; value: UsageContribution[] } | null = null;

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private file(machineId: string): string {
    // The schema's id charset already excludes path separators; the name check is belt and braces.
    const name = `${machineId}.json`;
    if (!FILE_RE.test(name) || name.startsWith('.')) throw new Error('invalid machine id');
    return path.join(this.dir, name);
  }

  private async read(machineId: string): Promise<StoredFile | null> {
    const raw = await readFile(this.file(machineId), 'utf8').catch(() => null);
    if (raw === null) return null;
    try {
      const j = JSON.parse(raw) as { receivedAt?: unknown; contribution?: unknown };
      const c = UsageContribution.safeParse(j.contribution);
      if (!c.success || typeof j.receivedAt !== 'number') return null;
      return { receivedAt: j.receivedAt, contribution: c.data };
    } catch {
      return null;
    }
  }

  private async machineIds(): Promise<string[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    return names.filter((n) => FILE_RE.test(n) && !n.startsWith('.')).map((n) => n.slice(0, -5));
  }

  /** Merge `c` into what `c.machineId` sent before. Serialized: one write at a time. */
  upsert(c: UsageContribution): Promise<StoredContributionInfo> {
    const run = this.chain.then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const ids = await this.machineIds();
      if (!ids.includes(c.machineId) && ids.length >= MAX_MACHINES) {
        throw new ContributionLimitError(
          `this hub already holds contributions from ${String(MAX_MACHINES)} machines`,
        );
      }
      const now = this.now();
      const prev = await this.read(c.machineId);
      const merged = mergeContribution(prev?.contribution ?? null, c, now - KEEP_DAYS * DAY_MS);
      // Never write what a later read would refuse: that machine would drop out of the
      // stats and its next push would merge into nothing.
      const valid = UsageContribution.safeParse(merged);
      if (!valid.success) {
        throw new Error(
          `merged contribution is invalid: ${valid.error.issues.map((i) => i.message).join('; ')}`,
        );
      }
      const target = this.file(c.machineId);
      const tmp = `${target}.${String(process.pid)}.${String(now)}.tmp`;
      await writeFile(tmp, JSON.stringify({ receivedAt: now, contribution: merged }), {
        mode: 0o600,
      });
      await rename(tmp, target);
      this.memo = null;
      clearUsageStatsCache();
      return infoOf(c.machineId, now, merged);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Every stored contribution. Memoized briefly: the stats read calls it per request. */
  async list(): Promise<UsageContribution[]> {
    const now = this.now();
    if (this.memo && now - this.memo.at < 10_000) return this.memo.value;
    const out: UsageContribution[] = [];
    for (const id of await this.machineIds()) {
      const f = await this.read(id);
      if (f) out.push(f.contribution);
    }
    this.memo = { at: now, value: out };
    return out;
  }

  /** What each machine sent: counts only, for `GET /api/v1/usage/contributions`. */
  async info(): Promise<StoredContributionInfo[]> {
    const out: StoredContributionInfo[] = [];
    for (const id of await this.machineIds()) {
      const f = await this.read(id);
      if (f) out.push(infoOf(id, f.receivedAt, f.contribution));
    }
    return out.sort((a, b) => b.receivedAt - a.receivedAt);
  }
}

export class ContributionLimitError extends Error {}

function infoOf(
  machineId: string,
  receivedAt: number,
  c: UsageContribution,
): StoredContributionInfo {
  return {
    machineId,
    receivedAt,
    window: c.window,
    tz: c.tz,
    intervals: c.intervals.length,
    tokenRows: c.tokens.length,
    shippedRows: c.shipped.length,
    boxes: c.boxes.length,
    boxRuns: c.boxRuns.length,
  };
}

/**
 * This hub's contribution for the last `days` local days through today in `tz`,
 * from the same rows its own `/api/v1/usage/stats` reads (history + ledger).
 */
export async function buildContribution(
  deps: Pick<UsageStatsDeps, 'history' | 'ledger'>,
  opts: { machineId: string; days: number; tz: string; now: number },
): Promise<UsageContribution> {
  const until = dayKey(opts.now, opts.tz);
  const since = addDays(until, -(opts.days - 1));
  const from = dayStart(since, opts.tz);
  const to = dayStart(addDays(until, 1), opts.tz);
  const rows = await loadUsageRows(
    { ...deps, now: () => opts.now },
    { readFrom: from, from, to, tz: opts.tz, now: opts.now },
  );
  return toContribution(
    {
      sessions: rows.sessions,
      tokens: rows.tokens,
      events: rows.events,
      boxes: [...rows.boxes.values()],
      boxRuns: rows.boxRuns,
    },
    { machineId: opts.machineId, since, until, tz: opts.tz },
  );
}

// ── the PC side: push to the configured remote hub ──

export type SyncResult =
  | { status: 'pushed'; target: string; days: number; intervals: number; bytes: number }
  | { status: 'unchanged'; target: string }
  | { status: 'disabled' | 'no-remote' | 'no-machine-id' }
  | { status: 'failed'; target?: string; error: string };

export interface ContributionPusherDeps {
  /** `history.contributeUsage` (default true), read on every tick. */
  enabled(): Promise<boolean>;
  /** The configured control box, or null (none, or this hub IS one). */
  target(): Promise<{ url: string; apiKey: string } | null>;
  machineId(): string | undefined;
  build(opts: {
    machineId: string;
    days: number;
    tz: string;
    now: number;
  }): Promise<UsageContribution>;
  fetch?: typeof fetch;
  now?: () => number;
  tz?: () => string;
  log?: (line: string) => void;
}

/** Days a periodic push covers; a full push (start, on demand) covers a year. */
export const PERIODIC_DAYS = 35;
export const FULL_DAYS = 366;
const PUSH_TIMEOUT_MS = 30_000;

export interface ContributionPusher {
  /** The periodic push: the last weeks, only when they changed. */
  tick(): Promise<SyncResult>;
  /**
   * Push now. By default like a tick (the recent weeks, or the year on a first
   * push), skipped when unchanged; `full` sends the whole year whatever changed.
   */
  syncNow(opts?: { full?: boolean }): Promise<SyncResult>;
}

export function createContributionPusher(deps: ContributionPusherDeps): ContributionPusher {
  const now = deps.now ?? Date.now;
  const tz = deps.tz ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const doFetch = deps.fetch ?? fetch;
  // Per target: the hash of the last body it accepted, and whether it has had a full year.
  const lastHash = new Map<string, string>();
  const hadFull = new Set<string>();
  // The zone of the last accepted push: a change makes the hub drop the stored year.
  const lastTz = new Map<string, string>();
  let running: Promise<SyncResult> | null = null;

  async function push(full: boolean): Promise<SyncResult> {
    if (!(await deps.enabled())) return { status: 'disabled' };
    const target = await deps.target();
    if (!target) return { status: 'no-remote' };
    const machineId = deps.machineId();
    if (!machineId) return { status: 'no-machine-id' };
    // The first push to a hub sends the year, and so does one in a new zone (the
    // hub replaces everything a machine sent when its zone changes); later ones the
    // recent weeks.
    const zone = tz();
    const days =
      full || !hadFull.has(target.url) || lastTz.get(target.url) !== zone
        ? FULL_DAYS
        : PERIODIC_DAYS;
    let body: string;
    try {
      const c = await deps.build({ machineId, days, tz: zone, now: now() });
      body = JSON.stringify(c);
      const bytes = Buffer.byteLength(body, 'utf8');
      if (bytes > CONTRIBUTION_LIMITS.bytes) {
        return {
          status: 'failed',
          target: target.url,
          error: `contribution is ${String(bytes)} bytes, over the ${String(CONTRIBUTION_LIMITS.bytes)} limit`,
        };
      }
      const hash = createHash('sha256').update(body).digest('hex');
      if (!full && days === PERIODIC_DAYS && lastHash.get(target.url) === hash) {
        return { status: 'unchanged', target: target.url };
      }
      const res = await doFetch(`${target.url}/api/v1/usage/contributions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${target.apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          status: 'failed',
          target: target.url,
          error: `HTTP ${String(res.status)}${text ? `: ${text.slice(0, 300)}` : ''}`,
        };
      }
      lastHash.set(target.url, hash);
      lastTz.set(target.url, zone);
      if (days === FULL_DAYS) hadFull.add(target.url);
      return {
        status: 'pushed',
        target: target.url,
        days,
        intervals: c.intervals.length,
        bytes,
      };
    } catch (e) {
      return {
        status: 'failed',
        target: target.url,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // One push at a time; an on-demand sync waits for a running tick, then runs.
  function serialize(full: boolean): Promise<SyncResult> {
    const prev = running ?? Promise.resolve(null);
    const run = prev
      .catch(() => null)
      .then(() => push(full))
      .then((r) => {
        if (r.status === 'failed')
          deps.log?.(`usage contribution to ${r.target ?? '?'} failed: ${r.error}`);
        return r;
      });
    running = run;
    void run.finally(() => {
      if (running === run) running = null;
    });
    return run;
  }

  return { tick: () => serialize(false), syncNow: (o) => serialize(o?.full === true) };
}
