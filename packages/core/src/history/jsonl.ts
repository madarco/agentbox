import type { HistoryRecord, ParseState, RawChunk } from './types.js';

export type JsonObject = Record<string, unknown>;

/**
 * The incremental JSONL loop every line-oriented parser shares: carries the
 * bytes after the last newline in `state.partial`, hands each complete JSON
 * object line to `onLine` with its byte offset, and keeps every other state key
 * (a parser's own dedupe sets, last title, …) for `onLine` to read and update.
 */
export function parseJsonlChunk(
  chunk: RawChunk,
  state: ParseState,
  onLine: (line: JsonObject, at: number, state: ParseState) => HistoryRecord[],
): { records: HistoryRecord[]; state: ParseState } {
  const { partial, ...rest } = state;
  const carry = typeof partial === 'string' ? Buffer.from(partial, 'base64') : null;
  const buf = carry ? Buffer.concat([carry, Buffer.from(chunk.bytes)]) : Buffer.from(chunk.bytes);
  const base = chunk.offset - (carry?.length ?? 0);
  const next: ParseState = { ...rest };
  const records: HistoryRecord[] = [];
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, start);
    if (nl === -1) break;
    const raw = buf.subarray(start, nl).toString('utf8');
    if (raw.trim()) {
      let line: unknown;
      try {
        line = JSON.parse(raw);
      } catch {
        line = undefined; // a non-JSON line is kept in raw, skipped here
      }
      if (line && typeof line === 'object' && !Array.isArray(line)) {
        records.push(...onLine(line as JsonObject, base + start, next));
      }
    }
    start = nl + 1;
  }
  if (start < buf.length) next.partial = buf.subarray(start).toString('base64');
  return { records, state: next };
}

/** Up to `maxLines` complete JSON object lines from a file's head. */
export function headJsonLines(head: Uint8Array, maxLines = 50): JsonObject[] {
  const out: JsonObject[] = [];
  for (const raw of Buffer.from(head).toString('utf8').split('\n').slice(0, maxLines)) {
    try {
      const v: unknown = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as JsonObject);
    } catch {
      /* torn or non-JSON */
    }
  }
  return out;
}

export function asObject(v: unknown): JsonObject | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : undefined;
}

export function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function finiteNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Turn text is capped in the projection; the raw keeps all of it. */
export const HISTORY_TEXT_MAX = 8_000;

export function clipText(s: string): string {
  return s.length > HISTORY_TEXT_MAX ? `${s.slice(0, HISTORY_TEXT_MAX)}…` : s;
}

/** Epoch ms (number) to ISO, or an ISO string through. */
export function isoTime(v: unknown): string | undefined {
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}
