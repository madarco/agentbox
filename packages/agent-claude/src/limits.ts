// Claude's plan limits (hub settings Phase 3b): the OAuth usage endpoint
// Claude Code's `/usage` reads, called hub-side with the account's stored
// access token. No turn, no quota. Never refreshed here: a refresh rotates the
// refresh token and would log out every other holder of the login. An expired
// token, an API key or a refusal is no data, never 0%.
import type { AgentPlanLimits, PlanLimitWindow } from '@agentbox/core';

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

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
export function claudeUsageWindows(body: unknown): PlanLimitWindow[] | null {
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
    const seen = new Map<string, number>();
    return rows.map(({ l, pct, group, scope }) => {
      const g = groupOf(group);
      const scopedSibling = rows.some((r) => r.group === group && r.scope);
      const suffix = scope ? `, ${scope}` : scopedSibling ? ', all models' : '';
      const resetsAt = str(l.resets_at);
      // Two rows of one kind and scope still need distinct ids (React keys).
      const base = `${str(l.kind) ?? group}${scope ? `:${scope}` : ''}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return {
        id: n === 1 ? base : `${base}#${String(n)}`,
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

export const claudePlanLimits: AgentPlanLimits = {
  async read(secret, ctx) {
    const token = claudeUsageToken(secret, ctx.now);
    if (!token) return null;
    const res = await ctx.fetch(CLAUDE_USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      signal: ctx.signal,
    });
    if (!res.ok) {
      // The status only: a body could echo the request.
      ctx.log?.(`usage endpoint answered ${String(res.status)}`);
      return null;
    }
    return claudeUsageWindows(await res.json());
  },
};
