import type { UsageShare } from '@agentbox/usage-view';

const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** 1,234 / 12.5 / 0.4: one decimal only while it still means something. */
export const num = (v: number): string => (Math.abs(v) >= 100 ? whole : oneDecimal).format(v);

export const speedup = (v: number): string => `${oneDecimal.format(v)}x`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-11-26` -> `26 Nov 2026`. */
export function longDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m! - 1]} ${y}`;
}

export const dateDay = (d: Date): string => longDay(d.toISOString().slice(0, 10));

/** `1 Nov - 26 Nov 2026`, the window the numbers cover (up to its last day with data). */
export function rangeText(share: UsageShare): string {
  const { since, today } = share.range;
  const a = longDay(since);
  const b = longDay(today);
  return since.slice(0, 4) === today.slice(0, 4) ? `${a.slice(0, -5)} - ${b}` : `${a} - ${b}`;
}

/** Singular when the printed number is "1" (0.96 hours prints as "1 hour"). */
const plural = (n: number, one: string, many = `${one}s`): string =>
  `${num(n)} ${num(n) === '1' ? one : many}`;

/** "9 agents at once" */
export const peakText = (share: UsageShare): string =>
  `${plural(share.hero.peakAtOnce, 'agent')} at once`;

/** "612 hours of work in 211 hours" */
export const hoursText = (share: UsageShare): string =>
  `${plural(share.hero.agentHours, 'hour')} of work in ${plural(share.hero.wallHours, 'hour')}`;

/** Title and description for the page metadata and the link preview: numbers only. */
export function shareMeta(share: UsageShare): { title: string; description: string } {
  const h = share.hero;
  // Below 1.1x there is no speed-up worth claiming (one agent at a time).
  const fast = h.speedup >= 1.1;
  return {
    title: `${share.handle}'s agents: ${peakText(share)}${fast ? `, ${speedup(h.speedup)} faster` : ''}`,
    description:
      `${hoursText(share)}${fast ? `, ${speedup(h.speedup)} speed-up` : ''}. ` +
      `${plural(h.prsMerged, 'PR')} merged, ${plural(h.commits, 'commit')}, ` +
      `+${num(h.additions)} / -${num(h.deletions)} lines (${rangeText(share)}).`,
  };
}
