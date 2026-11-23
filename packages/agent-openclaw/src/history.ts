/**
 * OpenClaw's session-history parser (docs/agent-history-plan.md, Phase 3b).
 *
 * OpenClaw keeps sessions in the default agent's live sqlite db, so the box's
 * row cursor (the `sqlite` block on openclaw's registry row) copies each
 * session's rows into `agentbox-history/<sessionId>.jsonl`, one `{t, id, u, row}`
 * line per new or changed row: `session_windows` (model, title, the previous
 * window for lineage), then `transcript_events`, whose `event_json` is one event
 * of pi's session format (the edge already decoded the zstd ones). A row comes
 * again when it changes or after a crash, so the parse state remembers which
 * events were projected.
 */
import {
  asObject,
  clipText,
  finiteNumber,
  headJsonLines,
  isoTime,
  nonEmptyString,
  parseJsonlChunk,
  type AgentHistoryModule,
  type HistoryRecord,
  type JsonObject,
  type ParseState,
} from '@agentbox/core';

function bag(state: ParseState, key: string): Record<string, string> {
  const v = state[key];
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, string>;
  const fresh: Record<string, string> = {};
  state[key] = fresh;
  return fresh;
}

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const o = asObject(b);
      return o && o.type === 'text' && typeof o.text === 'string' ? o.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function eventOf(row: JsonObject): JsonObject | undefined {
  if (typeof row.event_json !== 'string') return undefined;
  try {
    return asObject(JSON.parse(row.event_json));
  } catch {
    return undefined;
  }
}

function windowRecords(row: JsonObject, at: number, state: ParseState): HistoryRecord[] {
  const out: HistoryRecord[] = [];
  const ts = isoTime(row.updated_at);
  const tsPart = ts ? { ts } : {};
  const title = nonEmptyString(row.display_name);
  if (title && title !== state.title) {
    state.title = title;
    out.push({ kind: 'meta', title, ...tsPart, at });
  }
  const model = nonEmptyString(row.model);
  if (model && model !== state.model) {
    state.model = model;
    out.push({ kind: 'meta', model, ...tsPart, at });
  }
  return out;
}

function eventRecords(e: JsonObject, at: number, state: ParseState): HistoryRecord[] {
  const ts = nonEmptyString(e.timestamp);
  const tsPart = ts ? { ts } : {};
  if (e.type === 'session') {
    const cwd = nonEmptyString(e.cwd);
    if (!cwd || cwd === state.cwd) return [];
    state.cwd = cwd;
    return [{ kind: 'meta', cwd, ...tsPart, at }];
  }
  if (e.type === 'model_change') {
    const model = nonEmptyString(e.modelId);
    if (!model || model === state.model) return [];
    state.model = model;
    return [{ kind: 'meta', model, ...tsPart, at }];
  }
  // `custom` / `custom_message` are openclaw's injected context (runtime
  // context, the system prompt), not turns.
  if (e.type !== 'message') return [];
  const m = asObject(e.message);
  if (!m) return [];
  if (m.role === 'user') {
    const t = text(m.content).trim();
    return t ? [{ kind: 'turn', role: 'user', text: clipText(t), ...tsPart, at }] : [];
  }
  if (m.role !== 'assistant') return [];
  const out: HistoryRecord[] = [];
  const t = text(m.content).trim();
  if (t) out.push({ kind: 'turn', role: 'assistant', text: clipText(t), ...tsPart, at });
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      const o = asObject(b);
      const name = o?.type === 'toolCall' ? nonEmptyString(o.name) : undefined;
      if (name) out.push({ kind: 'tool', name, ...tsPart, at });
    }
  }
  const usage = asObject(m.usage);
  const messageId = nonEmptyString(e.id);
  if (usage && messageId) {
    const model = nonEmptyString(m.model);
    out.push({
      kind: 'usage',
      messageId,
      ...(model ? { model } : {}),
      inputTokens: finiteNumber(usage.input),
      outputTokens: finiteNumber(usage.output),
      cacheReadTokens: finiteNumber(usage.cacheRead),
      cacheWriteTokens: finiteNumber(usage.cacheWrite),
      ...tsPart,
      at,
    });
  }
  return out;
}

/** Records for one row line at byte offset `at`. */
export function openclawLineRecords(
  line: JsonObject,
  at: number,
  state: ParseState,
): HistoryRecord[] {
  const row = asObject(line.row);
  const id = nonEmptyString(line.id) ?? (typeof line.id === 'number' ? String(line.id) : '');
  if (!row || !id) return [];
  if (line.t === 'session_windows') return windowRecords(row, at, state);
  if (line.t !== 'transcript_events') return [];
  const seen = bag(state, 'events');
  if (seen[id]) return [];
  const e = eventOf(row);
  if (!e) return [];
  seen[id] = '1';
  return eventRecords(e, at, state);
}

export const openclawHistoryModule: AgentHistoryModule = {
  id: 'openclaw',
  parserVersion: 1,

  identify(head, path) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    if (!base.endsWith('.jsonl')) return null;
    const sessionId = base.slice(0, -'.jsonl'.length);
    if (!sessionId) return null;
    for (const line of headJsonLines(head, 20)) {
      if (line.t !== 'session_windows') continue;
      const parent = nonEmptyString(asObject(line.row)?.previous_session_id);
      if (parent && parent !== sessionId) return { sessionId, parentSessionId: parent };
      break;
    }
    return { sessionId };
  },

  parse: (chunk, state) => parseJsonlChunk(chunk, state, openclawLineRecords),
};
