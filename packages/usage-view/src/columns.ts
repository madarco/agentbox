import { addDays } from './aggregate.js';
import type {
  AgentId,
  DailyColumns,
  DailyStats,
  ProviderId,
  SplitValues,
  WallColumns,
  WallDay,
} from './schema.js';

type SplitCols = { tokens: number[]; agentHours: number[]; commits: number[] };
type DailyRow = Omit<DailyStats, 'byProject'>;

const DAILY_KEYS = [
  'tokens',
  'agentHours',
  'wallHours',
  'boxHours',
  'peak',
  'avgAtOnce',
  'commits',
  'prsMerged',
  'additions',
  'deletions',
  'files',
] as const;
const WALL_KEYS = ['all', 'peak', 'commits', 'prs', 'agentHours', 'tokens'] as const;

function encodeSplits<K extends string>(
  rows: readonly DailyRow[],
  pick: (r: DailyRow) => Partial<Record<K, SplitValues>>,
): Partial<Record<K, SplitCols>> {
  const keys = new Set<K>();
  for (const r of rows) for (const k of Object.keys(pick(r)) as K[]) keys.add(k);
  const out: Partial<Record<K, SplitCols>> = {};
  for (const k of keys) {
    out[k] = {
      tokens: rows.map((r) => pick(r)[k]?.tokens ?? 0),
      agentHours: rows.map((r) => pick(r)[k]?.agentHours ?? 0),
      commits: rows.map((r) => pick(r)[k]?.commits ?? 0),
    };
  }
  return out;
}

/** Rows must be consecutive days. `byProject` is dropped: a share carries no names. */
export function encodeDaily(rows: readonly DailyRow[], fallbackStart: string): DailyColumns {
  const cols = Object.fromEntries(DAILY_KEYS.map((k) => [k, rows.map((r) => r[k])])) as Record<
    (typeof DAILY_KEYS)[number],
    number[]
  >;
  return {
    start: rows[0]?.date ?? fallbackStart,
    ...cols,
    byAgent: encodeSplits<AgentId>(rows, (r) => r.byAgent),
    byProvider: encodeSplits<ProviderId>(rows, (r) => r.byProvider),
  };
}

function decodeSplits<K extends string>(
  cols: Partial<Record<K, SplitCols>>,
  i: number,
): Partial<Record<K, SplitValues>> {
  const out: Partial<Record<K, SplitValues>> = {};
  for (const k of Object.keys(cols) as K[]) {
    const c = cols[k]!;
    const v = {
      tokens: c.tokens[i] ?? 0,
      agentHours: c.agentHours[i] ?? 0,
      commits: c.commits[i] ?? 0,
    };
    if (v.tokens || v.agentHours || v.commits) out[k] = v;
  }
  return out;
}

export function decodeDaily(cols: DailyColumns): DailyRow[] {
  return cols.tokens.map((_, i) => ({
    date: addDays(cols.start, i),
    ...(Object.fromEntries(DAILY_KEYS.map((k) => [k, cols[k][i] ?? 0])) as Record<
      (typeof DAILY_KEYS)[number],
      number
    >),
    byAgent: decodeSplits(cols.byAgent, i),
    byProvider: decodeSplits(cols.byProvider, i),
  }));
}

export function encodeWall(rows: readonly WallDay[], fallbackStart: string): WallColumns {
  return {
    start: rows[0]?.date ?? fallbackStart,
    ...(Object.fromEntries(WALL_KEYS.map((k) => [k, rows.map((r) => r[k])])) as Record<
      (typeof WALL_KEYS)[number],
      number[]
    >),
  };
}

export function decodeWall(cols: WallColumns): WallDay[] {
  return cols.all.map((_, i) => ({
    date: addDays(cols.start, i),
    ...(Object.fromEntries(WALL_KEYS.map((k) => [k, cols[k][i] ?? 0])) as Record<
      (typeof WALL_KEYS)[number],
      number
    >),
  }));
}
