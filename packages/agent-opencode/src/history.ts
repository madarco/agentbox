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
  activityLine,
  asObject,
  clipText,
  finiteNumber,
  headJsonLines,
  isoTime,
  nonEmptyString,
  parseJsonlChunk,
  toolActivity,
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
    // opencode keeps the session's cumulative tokens and cost on its row
    // (columns since 1.x). A subagent session is its own session: its row
    // counts only itself, so the parent's total never includes it.
    if (row.tokens_input !== undefined) {
      const cost = finiteNumber(row.cost);
      out.push({
        kind: 'totals',
        inputTokens: finiteNumber(row.tokens_input),
        outputTokens: finiteNumber(row.tokens_output) + finiteNumber(row.tokens_reasoning),
        cacheReadTokens: finiteNumber(row.tokens_cache_read),
        cacheWriteTokens: finiteNumber(row.tokens_cache_write),
        reasoningTokens: finiteNumber(row.tokens_reasoning),
        ...(cost > 0 ? { costUsd: cost } : {}),
        ...(ts ? { ts } : {}),
        at,
      });
    }
    return out;
  }
  if (line.t === 'todo') return todoRecords(row, at, state);
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
    const cost = finiteNumber(data.cost);
    const context = finiteNumber(tokens.total);
    return [
      ...(context > 0
        ? [{ kind: 'context' as const, tokens: context, ...(ts ? { ts } : {}), at }]
        : []),
      {
        kind: 'usage',
        messageId: id,
        ...(model ? { model } : {}),
        inputTokens: finiteNumber(tokens.input),
        // Reasoning is billed as output; opencode counts it apart.
        outputTokens: finiteNumber(tokens.output) + finiteNumber(tokens.reasoning),
        cacheReadTokens: finiteNumber(cache?.read),
        cacheWriteTokens: finiteNumber(cache?.write),
        ...(cost > 0 ? { costUsd: cost } : {}),
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
    const line = toolActivity(name, asObject(data.state)?.input);
    return [
      { kind: 'tool', name, ...tsPart, at },
      ...(line ? [{ kind: 'activity' as const, text: line, ...tsPart, at }] : []),
    ];
  }
  if (data.type !== 'text' || data.synthetic === true || data.ignored === true) return [];
  const role = bag(state, 'roles')[String(row.message_id)];
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if ((role !== 'user' && role !== 'assistant') || !text) return [];
  seen[id] = '1';
  return [{ kind: 'turn', role, text: clipText(text), ...tsPart, at }];
}

/**
 * One `todo` row. A todo write replaces the whole list, so the current list is
 * the rows of the newest write (the highest `time_created`); its in-progress
 * item is the plan line, and a list with none clears it. A row of an older,
 * longer list is never re-copied once deleted, hence the write-time filter.
 */
function todoRecords(row: JsonObject, at: number, state: ParseState): HistoryRecord[] {
  const todos = bag(state, 'todos');
  const pos = String(row.position);
  const created = finiteNumber(row.time_created);
  todos[pos] = JSON.stringify({
    c: created,
    s: nonEmptyString(row.status) ?? '',
    t: nonEmptyString(row.content) ?? '',
  });
  const rows = Object.values(todos).map(
    (v) => JSON.parse(v) as { c: number; s: string; t: string },
  );
  const newest = Math.max(...rows.map((r) => r.c));
  const doing = rows.find((r) => r.c === newest && r.s === 'in_progress');
  const text = doing ? activityLine(doing.t) : '';
  if (text === (state.plan ?? '')) return [];
  state.plan = text;
  const ts = isoTime(row.time_updated);
  return [{ kind: 'activity', text, plan: true, ...(ts ? { ts } : {}), at }];
}

export const opencodeHistoryModule: AgentHistoryModule = {
  id: 'opencode',
  // 2: todos and tool parts as the working-on line, session totals, context.
  parserVersion: 2,

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
