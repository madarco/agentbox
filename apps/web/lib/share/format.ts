import { hoursSaved } from '@agentbox/usage-view';
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

/** `2026-11-19` -> `19 Nov`. */
export const dayMonth = (day: string): string => longDay(day).slice(0, -5);

export const dateDay = (d: Date): string => longDay(d.toISOString().slice(0, 10));

/** `1 Nov - 26 Nov 2026`, the window the numbers cover (up to its last day with data). */
export function rangeText(share: UsageShare): string {
  const { since, today } = share.range;
  const a = longDay(since);
  const b = longDay(today);
  if (since === today) return b;
  return since.slice(0, 4) === today.slice(0, 4) ? `${dayMonth(since)} - ${b}` : `${a} - ${b}`;
}

/** Singular when the printed number is "1" (0.96 hours prints as "1 hour"). */
const plural = (n: number, one: string, many = `${one}s`): string =>
  `${num(n)} ${num(n) === '1' ? one : many}`;

/** "9 agents at once" */
export const peakText = (share: UsageShare): string =>
  `${plural(share.hero.peakAtOnce, 'agent')} at once`;

/** What AgentBox is, in one line, for a stranger seeing a share in a feed. */
export const TAGLINE = 'AgentBox runs coding agents in parallel, each in its own sandbox.';

const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' });

const lastOfMonth = (day: string): boolean => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate() === d;
};

/**
 * "November 2026" when the share covers exactly one whole calendar month, else the
 * dates it covers ("1 Nov - 26 Nov 2026"). A share is frozen, so a month still in
 * progress is named by its dates, not as "so far".
 */
export function periodText(share: UsageShare): string {
  const { since, today } = share.range;
  if (since.endsWith('-01') && since.slice(0, 7) === today.slice(0, 7) && lastOfMonth(today)) {
    return `${monthName.format(new Date(`${since}T00:00:00Z`))} ${since.slice(0, 4)}`;
  }
  return rangeText(share);
}

/** "@madarco's coding agents · November 2026" */
export const shareTitle = (share: UsageShare): string =>
  `@${share.handle}'s coding agents · ${periodText(share)}`;

/** Below 1.1x there is no speed-up worth claiming (one agent at a time). */
export const hasSpeedup = (share: UsageShare): boolean => share.hero.speedup >= 1.1;

/** Hours saved worth a headline: a real speed-up and at least an hour. */
export const hasSaving = (share: UsageShare): boolean =>
  hasSpeedup(share) && hoursSaved(share.hero) >= 1;

/** "401 hours saved" */
export const savedText = (share: UsageShare): string =>
  `${plural(hoursSaved(share.hero), 'hour')} saved`;

/**
 * Title and description for the page metadata and the link preview. The title names
 * whose agents and when; the description carries the numbers. No free text but the handle.
 */
export function shareMeta(share: UsageShare): { title: string; description: string } {
  const h = share.hero;
  const peak = `${plural(h.peakAtOnce, 'agent')} running at the same time (peak)`;
  const work =
    `${plural(h.agentHours, 'hour')} of agent work in ${plural(h.wallHours, 'hour')}` +
    (hasSpeedup(share) ? `, ${speedup(h.speedup)} faster than one agent` : '') +
    (hasSaving(share) ? `. ${savedText(share)} vs. running one agent at a time` : '');
  return {
    title: shareTitle(share),
    description:
      `${peak}. ${work}. ` +
      `${plural(h.prsMerged, 'PR')} merged, ${plural(h.commits, 'commit')}, ` +
      `+${num(h.additions)} / -${num(h.deletions)} lines. ${TAGLINE}`,
  };
}
