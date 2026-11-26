import { AGENT_IDS, decodeDaily } from '@agentbox/usage-view';
import type { AgentId, UsageShare } from '@agentbox/usage-view';

/** At most this many bars: a long window is grouped into buckets of whole days. */
export const MAX_BARS = 92;
/** A short window still spans this many slots, so one day is not one huge bar. */
export const MIN_SLOTS = 14;
/** Agents named in the legend; the rest are summed as `other`. */
const TOP_AGENTS = 3;

export interface Bar {
  /** Most agents at once on any day of the bucket. */
  peak: number;
  /** Agent-hours by legend agent, in `agents` order. */
  hours: number[];
}

export interface DailySeries {
  /** Oldest first; `null` is an empty slot before the data starts. */
  bars: (Bar | null)[];
  /** Days per bar. */
  bucketDays: number;
  agents: AgentId[];
  maxPeak: number;
  maxHours: number;
  /** The date of the day with the most agents at once, or null with no activity. */
  peakDay: string | null;
  /** The slot of `peakDay`'s bar (the one highlighted), or -1. */
  peakIndex: number;
  /** Days drawn, and whether they start after the range does (a share keeps the last 62). */
  days: number;
  partial: boolean;
}

/** The daily columns as chart bars, up to the share's last day with data. */
export function dailySeries(share: UsageShare): DailySeries {
  const days = decodeDaily(share.daily).filter((d) => d.date <= share.range.today);

  const totals = new Map<AgentId, number>();
  for (const d of days) {
    for (const id of AGENT_IDS)
      totals.set(id, (totals.get(id) ?? 0) + (d.byAgent[id]?.agentHours ?? 0));
  }
  const ranked = AGENT_IDS.filter((id) => (totals.get(id) ?? 0) > 0).sort(
    (a, b) => totals.get(b)! - totals.get(a)!,
  );
  const named = ranked.length > TOP_AGENTS + 1 ? ranked.slice(0, TOP_AGENTS) : ranked;
  const agents: AgentId[] =
    named.length < ranked.length && !named.includes('other') ? [...named, 'other'] : named;
  const slotOf = (id: AgentId): number => {
    const i = agents.indexOf(id);
    return i >= 0 ? i : agents.indexOf('other');
  };

  const bucketDays = Math.max(1, Math.ceil(days.length / MAX_BARS));
  const bars: Bar[] = [];
  let peakDay: string | null = null;
  let peakBest = 0;
  let peakBar = -1;
  // Buckets end on the newest day, so a short remainder is the oldest bar, not today's.
  const first = days.length % bucketDays || bucketDays;
  for (let i = 0; i < days.length; i = i === 0 ? first : i + bucketDays) {
    const bar: Bar = { peak: 0, hours: agents.map(() => 0) };
    for (const d of days.slice(i, i === 0 ? first : i + bucketDays)) {
      bar.peak = Math.max(bar.peak, d.peak);
      if (d.peak > peakBest) {
        peakBest = d.peak;
        peakDay = d.date;
        peakBar = bars.length;
      }
      for (const id of AGENT_IDS) {
        const h = d.byAgent[id]?.agentHours ?? 0;
        const at = slotOf(id);
        if (h > 0 && at >= 0) bar.hours[at]! += h;
      }
    }
    bars.push(bar);
  }
  const pad = Math.max(0, MIN_SLOTS - bars.length);
  const padded: (Bar | null)[] = [...Array<null>(pad).fill(null), ...bars];
  return {
    bars: padded,
    bucketDays,
    agents,
    maxPeak: Math.max(0, ...bars.map((b) => b.peak)),
    maxHours: Math.max(0, ...bars.map((b) => b.hours.reduce((a, v) => a + v, 0))),
    peakDay,
    peakIndex: peakBar < 0 ? -1 : peakBar + pad,
    days: days.length,
    partial: days.length > 0 && days[0]!.date > share.range.since,
  };
}
