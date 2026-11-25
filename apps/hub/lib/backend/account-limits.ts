// Plan limits per subscription (docs/hub-settings-plan.md, Phase 3b). One
// meter per window the source reports, never a fixed set: plans differ (a
// verified Ultra or this Max 20x has no 5-hour window, codex Pro has weekly
// only) and change over time.
//
// Sources, both free of quota:
// - codex: the `rate_limits` the session transcript carries on every
//   `token_count`, kept by the history parser per account (no network call).
// - claude: the OAuth usage endpoint Claude Code's `/usage` reads, called here
//   with the account's stored access token. Never refreshed here: a refresh
//   rotates the refresh token and would log out every other holder (llm-accounts
//   plan). An expired token, an API key or a refusal means no data, never 0%.
import type { HistoryLimitWindow } from '@agentbox/core';
import type { HistoryAccountLimits } from './history';

export interface AccountLimitWindow {
  /** Stable within the source. */
  id: string;
  /** `5-hour`, `Weekly`, `Weekly, Fable`. */
  label: string;
  /** Percent used, 0-100 (100 or more is at the limit). */
  pct: number;
  /** ISO time the window resets. */
  resetsAt?: string;
  windowMinutes?: number;
}

export interface AccountLimits {
  windows: AccountLimitWindow[];
  atLimit: boolean;
  /** When the source reported these values (ISO). */
  updatedAt: string;
  source: 'usage-api' | 'transcript';
}

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** At most one usage call per account in this long (plan Phase 3b, step 3). */
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

/** A codex account's limits from the newest transcript record. Pure. */
export function codexLimits(h: HistoryAccountLimits): AccountLimits {
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

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

function groupOf(group: string): { label: string; minutes?: number } {
  if (/five|5h|session/i.test(group)) return { label: '5-hour', minutes: 300 };
  if (/week|seven|7d/i.test(group)) return { label: 'Weekly', minutes: 10_080 };
  if (/day|daily/i.test(group)) return { label: 'Daily', minutes: 1_440 };
  return { label: group.charAt(0).toUpperCase() + group.slice(1).replace(/_/g, ' ') };
}

/**
 * The windows of a claude OAuth usage response. `limits[]` is the generic list
 * (`{kind, group, percent, resets_at, scope.model.display_name}`); the older
 * fixed fields (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`)
 * are read when it is absent. A null field is a window the plan does not have.
 * Null when the body has neither shape. Pure.
 */
export function claudeUsageWindows(body: unknown): AccountLimitWindow[] | null {
  const b = obj(body);
  if (!b) return null;
  if (Array.isArray(b.limits)) {
    const rows = b.limits.flatMap((raw) => {
      const l = obj(raw);
      const pct = num(l?.percent);
      if (!l || pct === null) return [];
      const group = str(l.group) ?? str(l.kind) ?? 'limit';
      const scope = str(obj(obj(l.scope)?.model)?.display_name);
      return [{ l, pct, group, scope }];
    });
    return rows.map(({ l, pct, group, scope }) => {
      const g = groupOf(group);
      const scopedSibling = rows.some((r) => r.group === group && r.scope);
      const suffix = scope ? `, ${scope}` : scopedSibling ? ', all models' : '';
      const resetsAt = str(l.resets_at);
      return {
        id: `${str(l.kind) ?? group}${scope ? `:${scope}` : ''}`,
        label: g.label + suffix,
        pct,
        ...(resetsAt ? { resetsAt } : {}),
        ...(g.minutes ? { windowMinutes: g.minutes } : {}),
      };
    });
  }
  const fixed: Array<[string, string, number]> = [
    ['five_hour', '5-hour', 300],
    ['seven_day', 'Weekly', 10_080],
    ['seven_day_opus', 'Weekly, Opus', 10_080],
    ['seven_day_sonnet', 'Weekly, Sonnet', 10_080],
  ];
  if (!fixed.some(([k]) => k in b)) return null;
  return fixed.flatMap(([key, label, minutes]) => {
    const w = obj(b[key]);
    const pct = num(w?.utilization);
    if (!w || pct === null) return [];
    const resetsAt = str(w.resets_at);
    return [{ id: key, label, pct, windowMinutes: minutes, ...(resetsAt ? { resetsAt } : {}) }];
  });
}

/**
 * The bearer token for the usage endpoint from a claude account's stored
 * secret: a login's access token while it is valid, a setup token as is. An
 * API key, an expired login or anything else: null. Pure.
 */
export function claudeUsageToken(secret: string | null, nowMs: number): string | null {
  if (!secret) return null;
  let parsed: Json | null = null;
  try {
    parsed = obj(JSON.parse(secret));
  } catch {
    return null;
  }
  if (!parsed) return null;
  if (parsed.kind === 'setup-token') return str(parsed.token) ?? null;
  const oauth = obj(parsed.claudeAiOauth);
  const token = str(oauth?.accessToken);
  const expires = num(oauth?.expiresAt);
  // A minute of slack: a token about to expire is the refresh's to renew.
  if (!token || (expires !== null && expires < nowMs + 60_000)) return null;
  return token;
}

export interface LimitsSourceDeps {
  /** An account's stored secret (`readAccountSecret`). */
  readSecret: (agent: string, id: string) => Promise<string | null>;
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
   * `LIMITS_REFRESH_MS`; otherwise the last value read is returned.
   */
  limitsFor(agent: string, id: string, running: boolean): Promise<AccountLimits | undefined>;
}

export function createLimitsSource(deps: LimitsSourceDeps): LimitsSource {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const cache = new Map<string, { at: number; limits?: AccountLimits }>();
  const inflight = new Map<string, Promise<void>>();

  async function fetchClaude(key: string, agent: string, id: string): Promise<void> {
    const token = claudeUsageToken(await deps.readSecret(agent, id), now());
    const entry = cache.get(key);
    cache.set(key, { at: now(), ...(entry?.limits ? { limits: entry.limits } : {}) });
    if (!token) return;
    try {
      const res = await doFetch(CLAUDE_USAGE_URL, {
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        // The status only: a body could echo the request.
        deps.log?.(`limits: ${key} usage endpoint answered ${String(res.status)}`);
        return;
      }
      const windows = claudeUsageWindows(await res.json());
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
      deps.log?.(`limits: ${key} usage endpoint failed: ${(err as Error).name}`);
    }
  }

  return {
    async limitsFor(agent, id, running) {
      const key = `${agent}/${id}`;
      if (agent === 'claude') {
        const entry = cache.get(key);
        if (running && (!entry || now() - entry.at >= LIMITS_REFRESH_MS)) {
          let p = inflight.get(key);
          if (!p) {
            p = fetchClaude(key, agent, id).finally(() => inflight.delete(key));
            inflight.set(key, p);
          }
          await p;
        }
        return cache.get(key)?.limits;
      }
      const h = await deps.transcriptLimits(key).catch(() => null);
      return h && h.windows.length > 0 ? codexLimits(h) : undefined;
    },
  };
}
