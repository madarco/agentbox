import type { HistoryBinding } from './types.js';

/**
 * The append-only session → box binding log, relative to the box user's home.
 * On the box's own writable layer (never a shared volume), so it is per box and
 * dies with it. FROZEN: written by the ctl baked into a box, read by the host.
 */
export const HISTORY_BINDINGS_FILE = '.local/state/agentbox/history-bindings.jsonl';

/** Parse the log, dropping malformed lines (a torn last line included). */
export function parseBindingLog(text: string): HistoryBinding[] {
  const out: HistoryBinding[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Partial<HistoryBinding>;
      if (typeof v.agent === 'string' && typeof v.sessionId === 'string') {
        out.push({
          ts: typeof v.ts === 'string' ? v.ts : '',
          agent: v.agent,
          sessionId: v.sessionId,
          ...(typeof v.transcriptPath === 'string' ? { transcriptPath: v.transcriptPath } : {}),
        });
      }
    } catch {
      /* torn or foreign line */
    }
  }
  return out;
}
