/**
 * OpenCode's session-history parser (docs/agent-history-plan.md, Phase 0
 * "opencode").
 *
 * OpenCode keeps sessions in a live sqlite db, so the box's row cursor (the
 * `sqlite` block on opencode's registry row) copies each bound session's rows
 * into `agentbox-history/<sessionId>.jsonl`, one `{t, id, u, row}` line per new
 * or changed row: `session`, then `message` (role, model, tokens in its JSON
 * `data`), then `part` (text and tool calls, after their message). A row comes
 * again when it changes, so the parse state remembers which messages and parts
 * were already projected.
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

function dataOf(row: JsonObject): JsonObject | undefined {
  if (typeof row.data !== 'string') return asObject(row.data);
  try {
    return asObject(JSON.parse(row.data));
  } catch {
    return undefined;
  }
}

function bag(state: ParseState, key: string): Record<string, string> {
  const v = state[key];
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, string>;
  const fresh: Record<string, string> = {};
  state[key] = fresh;
  return fresh;
}

/** Records for one row line at byte offset `at`. */
export function opencodeLineRecords(
  line: JsonObject,
  at: number,
  state: ParseState,
): HistoryRecord[] {
  const row = asObject(line.row);
  const id = nonEmptyString(line.id);
  if (!row || !id) return [];
  if (line.t === 'session') {
    const out: HistoryRecord[] = [];
    const ts = isoTime(row.time_updated);
    const title = nonEmptyString(row.title);
    if (title && title !== state.title) {
      state.title = title;
      out.push({ kind: 'meta', title, ...(ts ? { ts } : {}), at });
    }
    const cwd = nonEmptyString(row.directory);
    if (cwd && cwd !== state.cwd) {
      state.cwd = cwd;
      out.push({ kind: 'meta', cwd, ...(ts ? { ts } : {}), at });
    }
    return out;
  }
  const data = dataOf(row);
  if (!data) return [];
  if (line.t === 'message') {
    const role = nonEmptyString(data.role);
    if (role) bag(state, 'roles')[id] = role;
    const time = asObject(data.time);
    const used = bag(state, 'usage');
    // Tokens are final once the message completed; earlier copies are skipped.
    if (role !== 'assistant' || !time?.completed || used[id]) return [];
    used[id] = '1';
    const tokens = asObject(data.tokens);
    if (!tokens) return [];
    const cache = asObject(tokens.cache);
    const model = nonEmptyString(data.modelID);
    const ts = isoTime(time.completed);
    return [
      {
        kind: 'usage',
        messageId: id,
        ...(model ? { model } : {}),
        inputTokens: finiteNumber(tokens.input),
        // Reasoning is billed as output; opencode counts it apart.
        outputTokens: finiteNumber(tokens.output) + finiteNumber(tokens.reasoning),
        cacheReadTokens: finiteNumber(cache?.read),
        cacheWriteTokens: finiteNumber(cache?.write),
        ...(ts ? { ts } : {}),
        at,
      },
    ];
  }
  if (line.t !== 'part') return [];
  const seen = bag(state, 'parts');
  if (seen[id]) return [];
  const ts = isoTime(asObject(data.time)?.start) ?? isoTime(row.time_created);
  const tsPart = ts ? { ts } : {};
  if (data.type === 'tool') {
    const name = nonEmptyString(data.tool);
    if (!name) return [];
    seen[id] = '1';
    return [{ kind: 'tool', name, ...tsPart, at }];
  }
  if (data.type !== 'text' || data.synthetic === true || data.ignored === true) return [];
  const role = bag(state, 'roles')[String(row.message_id)];
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if ((role !== 'user' && role !== 'assistant') || !text) return [];
  seen[id] = '1';
  return [{ kind: 'turn', role, text: clipText(text), ...tsPart, at }];
}

export const opencodeHistoryModule: AgentHistoryModule = {
  id: 'opencode',
  parserVersion: 1,

  identify(head, path) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    if (!base.endsWith('.jsonl')) return null;
    const sessionId = base.slice(0, -'.jsonl'.length);
    if (!sessionId) return null;
    for (const line of headJsonLines(head, 20)) {
      if (line.t !== 'session') continue;
      const parent = nonEmptyString(asObject(line.row)?.parent_id);
      if (parent && parent !== sessionId) return { sessionId, parentSessionId: parent };
      break;
    }
    return { sessionId };
  },

  parse: (chunk, state) => parseJsonlChunk(chunk, state, opencodeLineRecords),
};
