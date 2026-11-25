// Plan limits per subscription (docs/hub-settings-plan.md, Phase 3b). One
// meter per window the source reports, never a fixed set: plans differ (a
// verified Ultra or this Max 20x has no 5-hour window, codex Pro has weekly
// only) and change over time.
//
// Two kinds of source, both free of quota, chosen by the agent's module:
// - a reader (`AgentHistoryModule.planLimits`, claude's usage endpoint) called
//   with the account's stored secret, cached here, at most every 5 minutes and
//   only while a box on the account runs;
// - otherwise the newest `limits` history record a session on the account
//   shipped (codex's `token_count.rate_limits`; no network call).
// No reader answer, no record: no data, never 0%.
import {
  agentHistoryModule,
  type AgentPlanLimits,
  type HistoryLimitWindow,
  type PlanLimitWindow,
} from '@agentbox/core';
import type { HistoryAccountLimits } from './history';

export type AccountLimitWindow = PlanLimitWindow;

export interface AccountLimits {
  windows: AccountLimitWindow[];
  atLimit: boolean;
  /** When the source reported these values (ISO). */
  updatedAt: string;
  source: 'usage-api' | 'transcript';
}

/** At most one usage call per account in this long (plan Phase 3b, step 3). */
/** How long a listing waits on a usage call before answering without it. */
export const FIRST_READ_WAIT_MS = 1_500;
export const LIMITS_REFRESH_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;

/** `5-hour`, `Weekly`, or the length spelled out, from a window's minutes. */
export function windowLabel(minutes: number | undefined, fallback: string): string {
  if (!minutes || minutes <= 0) return fallback;
  if (minutes === 300) return '5-hour';
  if (minutes === 10_080) return 'Weekly';
  if (minutes === 1_440) return 'Daily';
  if (minutes % 1_440 === 0) return `${String(minutes / 1_440)}-day`;
  if (minutes % 60 === 0) return `${String(minutes / 60)}-hour`;
  return `${String(minutes)}-minute`;
}

const atLimitOf = (windows: readonly { pct: number }[]): boolean =>
  windows.some((w) => w.pct >= 100);

/**
 * Drops the windows that have reset since they were read: their old percent
 * is no longer true and the new one is unknown. Undefined when none is left,
 * so a stale "at limit" never outlives its window.
 */
export function freshLimits(
  l: AccountLimits | undefined,
  nowMs: number,
): AccountLimits | undefined {
  if (!l) return undefined;
  const windows = l.windows.filter((w) => !w.resetsAt || Date.parse(w.resetsAt) > nowMs);
  if (windows.length === 0) return undefined;
  if (windows.length === l.windows.length) return l;
  return { ...l, windows, atLimit: atLimitOf(windows) };
}

/** An account's limits from the newest transcript record. Pure. */
export function transcriptLimitsView(h: HistoryAccountLimits): AccountLimits {
  const windows = h.windows.map(
    (w: HistoryLimitWindow): AccountLimitWindow => ({
      id: w.id,
      label: windowLabel(w.windowMinutes, w.id),
      pct: w.pct,
      ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
      ...(w.windowMinutes ? { windowMinutes: w.windowMinutes } : {}),
    }),
  );
  return {
    windows,
    atLimit: atLimitOf(windows) || Boolean(h.reached),
    updatedAt: h.ts ?? new Date(h.updatedAt).toISOString(),
    source: 'transcript',
  };
}

export interface LimitsSourceDeps {
  /** An account's stored secret (`readAccountSecret`). */
  readSecret: (agent: string, id: string) => Promise<string | null>;
  /** The agent's limits reader; default: its registered history module's. */
  readerOf?: (agent: string) => AgentPlanLimits | undefined;
  /** The newest transcript limits of a subscription (`agent/account`). */
  transcriptLimits: (subscription: string) => Promise<HistoryAccountLimits | null>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export interface LimitsSource {
  /**
   * The account's limits, or undefined (no data). `running`: a box on it runs,
   * which is the only time a usage call is made, at most every
   * `LIMITS_REFRESH_MS`; otherwise the last value read is returned. A call
   * waits at most `FIRST_READ_WAIT_MS` for the endpoint, so a slow one never
   * holds the accounts list; its answer lands for the next read.
   */
  limitsFor(agent: string, id: string, running: boolean): Promise<AccountLimits | undefined>;
  /** Forget an account's cached limits (it was removed; a new one may reuse the id). */
  forget(agent: string, id: string): void;
}

export function createLimitsSource(deps: LimitsSourceDeps): LimitsSource {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const cache = new Map<string, { at: number; limits?: AccountLimits }>();
  const inflight = new Map<string, Promise<void>>();

  const readerOf = deps.readerOf ?? ((agent: string) => agentHistoryModule(agent)?.planLimits);

  async function read(
    key: string,
    reader: AgentPlanLimits,
    agent: string,
    id: string,
  ): Promise<void> {
    const secret = await deps.readSecret(agent, id).catch(() => null);
    const entry = cache.get(key);
    cache.set(key, { at: now(), ...(entry?.limits ? { limits: entry.limits } : {}) });
    try {
      const windows = await reader.read(secret, {
        fetch: doFetch,
        now: now(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        log: (line) => deps.log?.(`limits: ${key} ${line}`),
      });
      if (!windows) return;
      cache.set(key, {
        at: now(),
        limits: {
          windows,
          atLimit: atLimitOf(windows),
          updatedAt: new Date(now()).toISOString(),
          source: 'usage-api',
        },
      });
    } catch (err) {
      deps.log?.(`limits: ${key} read failed: ${(err as Error).name}`);
    }
  }

  return {
    async limitsFor(agent, id, running) {
      const key = `${agent}/${id}`;
      const reader = readerOf(agent);
      if (reader) {
        const entry = cache.get(key);
        let p = inflight.get(key);
        if (!p && running && (!entry || now() - entry.at >= LIMITS_REFRESH_MS)) {
          p = read(key, reader, agent, id).finally(() => inflight.delete(key));
          inflight.set(key, p);
        }
        if (p) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            p,
            new Promise<void>((r) => {
              timer = setTimeout(r, FIRST_READ_WAIT_MS);
            }),
          ]);
          clearTimeout(timer);
        }
        return freshLimits(cache.get(key)?.limits, now());
      }
      const h = await deps.transcriptLimits(key).catch(() => null);
      return h && h.windows.length > 0 ? freshLimits(transcriptLimitsView(h), now()) : undefined;
    },
    forget(agent, id) {
      cache.delete(`${agent}/${id}`);
    },
  };
}
