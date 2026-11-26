import { daysBetween } from '../aggregate.js';
import type { AgentId, ProviderId, RangeId } from '../schema.js';

/**
 * Compact number: 812, 1.2k, 38k, 126.4M, 1.25B. Each tier checks its own rounded
 * text, so 999,999 prints as 1.0M rather than 1000k.
 */
export function fmt(n: number): string {
  if (Math.round(n) < 1000) return String(Math.round(n));
  if (n < 1e4) {
    const k = (n / 1e3).toFixed(1);
    if (k !== '10.0') return k + 'k';
  }
  if (Math.round(n / 1e3) < 1000) return Math.round(n / 1e3) + 'k';
  const m = (n / 1e6).toFixed(1);
  if (Number(m) < 1000) return m + 'M';
  return (n / 1e9).toFixed(2) + 'B';
}

/** Like `fmt`, but keeps one decimal up to 100k: 38.2k, 11.4k, 214k. */
export function fmtLines(n: number): string {
  if (n >= 1e4 && n < 1e5) {
    const k = (n / 1e3).toFixed(1);
    if (k !== '100.0') return k + 'k';
  }
  return fmt(n);
}

export const nf = (n: number): string => Math.round(n).toLocaleString('en-US');

/** One decimal under 10, whole numbers above: 2.9, 14, 612. */
export const hrs = (n: number): string => (n < 10 ? String(Math.round(n * 10) / 10) : nf(n));
/** `hrs(n)` hours, singular when it prints as 1. */
export const hoursLabel = (n: number): string => `${hrs(n)} ${hrs(n) === '1' ? 'hour' : 'hours'}`;

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DOW_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
export const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const parse = (day: string): Date => new Date(`${day}T00:00:00Z`);
export const dow = (day: string): number => parse(day).getUTCDay();
export const dayNum = (day: string): number => parse(day).getUTCDate();
export const monthIdx = (day: string): number => parse(day).getUTCMonth();
/** "Thu 19" */
export const shortDay = (day: string): string => `${DOW[dow(day)]} ${dayNum(day)}`;
/** "Thu 19 Nov" */
export const dayMonth = (day: string): string => `${shortDay(day)} ${MONTHS[monthIdx(day)]}`;
/** "19 Nov" */
export const dm = (day: string): string => `${dayNum(day)} ${MONTHS[monthIdx(day)]}`;
/** "Thu, 19 Nov 2026" */
export const fullDay = (day: string): string =>
  `${DOW[dow(day)]}, ${dayNum(day)} ${MONTHS[monthIdx(day)]} ${parse(day).getUTCFullYear()}`;

export const daysInclusive = (from: string, to: string): number => daysBetween(from, to).length;

/** "09:30" from hours since midnight; past 24 wraps. */
export const hm = (h: number): string => {
  const m = Math.round((((h % 24) + 24) % 24) * 60);
  return String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
};

export const duration = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} m` : `${m} m`;
};

/** The window, as the hero's eyebrow says it. */
export function rangeLabel(id: RangeId, since: string, until: string, today: string): string {
  const last = today < until ? today : until;
  const n = daysInclusive(since, last);
  if (id === 'month') {
    const month = MONTHS_LONG[monthIdx(since)];
    return today < until ? `${month} so far · ${n} days` : `${month} · ${n} days`;
  }
  return `Last ${n} days`;
}

/** What the KPI deltas compare against. */
export function previousLabel(id: RangeId, since: string): string {
  if (id === 'month') return MONTHS_LONG[(monthIdx(since) + 11) % 12]!;
  if (id === '7d') return 'the week before';
  if (id === '30d') return 'the 30 days before';
  if (id === '90d') return 'the 90 days before';
  return 'the year before';
}

/** The phrase for "this month" in section titles. */
export function rangeNoun(id: RangeId): string {
  return id === 'month'
    ? 'this month'
    : id === '7d'
      ? 'this week'
      : id === '30d'
        ? 'in the last 30 days'
        : id === '90d'
          ? 'in the last 90 days'
          : 'this year';
}

export const AGENT_LABEL: Record<AgentId, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
  openclaw: 'openclaw',
  other: 'other',
};

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  docker: 'docker',
  hetzner: 'hetzner',
  daytona: 'daytona',
  vercel: 'vercel',
  e2b: 'e2b',
  'remote-docker': 'remote-docker',
  digitalocean: 'digitalocean',
  host: 'this PC',
  other: 'other',
};

export const AGENT_COLOR: Record<AgentId, string> = {
  claude: 'var(--s1)',
  codex: 'var(--s2)',
  pi: 'var(--s3)',
  opencode: 'var(--s4)',
  openclaw: 'var(--s5)',
  other: 'var(--faint)',
};

export const PROVIDER_COLOR: Record<ProviderId, string> = {
  docker: 'var(--s1)',
  hetzner: 'var(--s2)',
  daytona: 'var(--s3)',
  vercel: 'var(--s4)',
  e2b: 'var(--s5)',
  'remote-docker': 'var(--s6)',
  digitalocean: 'var(--s7)',
  host: 'var(--s8)',
  other: 'var(--faint)',
};

export const SERIES_COLORS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'].map(
  (v) => `var(${v})`,
);

/** Nice axis maximum at or above `v`. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Bar with a rounded top (data end) and a square baseline. */
export function barPath(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.max(0, Math.min(r, h, w / 2));
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function barPathDown(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.max(0, Math.min(r, h, w / 2));
  return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
}
