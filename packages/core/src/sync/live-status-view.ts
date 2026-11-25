/**
 * Presentation rules for an agent's live status (docs/agent-live-status-plan.md,
 * Phase 4), shared by the CLI and, as a parity-tested mirror, the hub web UI
 * (whose client bundle cannot value-import an `@agentbox/*` package).
 *
 * Absent means "no data" everywhere here: a helper answers `undefined` rather
 * than 0, so a surface renders nothing instead of a misleading "0".
 */

/** Token usage of an agent's current session, as `GET /api/v1/boxes` sends it. */
export interface AgentLiveUsageView {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  contextTokens?: number;
  contextWindow?: number;
  costUsd?: number;
  updatedAt?: string;
}

/**
 * The states during which `activity` is a working-on line. Outside them the
 * hub's derived text is the session's last output (an idle claude or pi box
 * ends on its final reply), which would read as "still doing X".
 */
const LIVE_ACTIVITY_STATES: ReadonlySet<string> = new Set(['working', 'waiting', 'question']);

export function isLiveActivityState(state: string | undefined): boolean {
  return state !== undefined && LIVE_ACTIVITY_STATES.has(state);
}

/** `activity` when it is a working-on line for `state`, else undefined. */
export function liveActivity(entry: { state?: string; activity?: string }): string | undefined {
  if (!entry.activity || !isLiveActivityState(entry.state)) return undefined;
  return entry.activity;
}

/**
 * 950, 12.3k, 123k, 1.2M, 1.23B. The thresholds sit just under each power of
 * 1000 so a value that would round up to "1000k" is promoted to "1M" instead.
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 999_995_000) return `${trim((n / 1e9).toFixed(2))}B`;
  if (n >= 999_500) return `${trim((n / 1e6).toFixed(1))}M`;
  if (n >= 99_950) return `${String(Math.round(n / 1e3))}k`;
  if (n >= 999.5) return `${trim((n / 1e3).toFixed(1))}k`;
  return String(Math.round(n));
}

/** `1.0M` reads as noise next to `1.2M`. */
function trim(s: string): string {
  return s.replace(/\.0+$/, '');
}

/** Every token the session moved, or undefined when there is no usage at all. */
export function usageTotal(u: AgentLiveUsageView | undefined): number | undefined {
  if (!u) return undefined;
  const total = u.input + u.output + u.cacheRead + u.cacheWrite + (u.reasoning ?? 0);
  return total > 0 ? total : undefined;
}

/** Context fill as a whole percent (0-100), or undefined without both numbers. */
export function contextFillPct(u: AgentLiveUsageView | undefined): number | undefined {
  if (!u || u.contextTokens === undefined || !u.contextWindow || u.contextWindow <= 0) {
    return undefined;
  }
  return Math.min(100, Math.max(0, Math.round((u.contextTokens / u.contextWindow) * 100)));
}

/** `$0.42`; undefined unless a positive cost was recorded. */
export function formatCostUsd(u: AgentLiveUsageView | undefined): string | undefined {
  if (!u || u.costUsd === undefined || !(u.costUsd > 0)) return undefined;
  return u.costUsd < 0.01 ? '<$0.01' : `$${u.costUsd.toFixed(2)}`;
}

/** The compact figure: `1.2M tok · 45% ctx · $0.42`, parts omitted when absent. */
export function usageSummary(u: AgentLiveUsageView | undefined): string | undefined {
  const total = usageTotal(u);
  const fill = contextFillPct(u);
  const cost = formatCostUsd(u);
  const parts: string[] = [];
  if (total !== undefined) parts.push(`${formatTokenCount(total)} tok`);
  if (fill !== undefined) parts.push(`${String(fill)}% ctx`);
  if (cost !== undefined) parts.push(cost);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** Label/value rows for the full breakdown (a tooltip, `inspect`). */
export function usageBreakdown(u: AgentLiveUsageView | undefined): Array<[string, string]> {
  if (!u) return [];
  const rows: Array<[string, string]> = [
    ['input', formatTokenCount(u.input)],
    ['output', formatTokenCount(u.output)],
    ['cache read', formatTokenCount(u.cacheRead)],
    ['cache write', formatTokenCount(u.cacheWrite)],
  ];
  if (u.reasoning !== undefined) rows.push(['reasoning', formatTokenCount(u.reasoning)]);
  const fill = contextFillPct(u);
  if (fill !== undefined && u.contextTokens !== undefined && u.contextWindow) {
    rows.push([
      'context',
      `${formatTokenCount(u.contextTokens)} / ${formatTokenCount(u.contextWindow)} (${String(fill)}%)`,
    ]);
  } else if (u.contextTokens !== undefined) {
    rows.push(['context', formatTokenCount(u.contextTokens)]);
  }
  const cost = formatCostUsd(u);
  if (cost !== undefined) rows.push(['cost', cost]);
  return rows;
}
