/**
 * Codex's session-history parser (docs/agent-history-plan.md, Phase 0 "codex").
 *
 * A rollout is `sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, one
 * `{timestamp, type, payload}` record per line. The session id is the uuid the
 * file name ends with (= `session_meta.payload.id`); the name is used because
 * the first record carries the full base instructions and can outgrow the
 * first frame. Lineage: `forked_from_id`, `parent_thread_id`, or a sub-agent's
 * `source.subagent.thread_spawn.parent_thread_id`.
 *
 * User turns come from `response_item` messages (minus the context codex
 * injects as user messages), so the `event_msg` copies are skipped. Usage comes
 * from `token_usage_record`, one per Responses API response.
 */
import {
  activityLine,
  asObject,
  clipText,
  finiteNumber,
  headJsonLines,
  nonEmptyString,
  parseJsonlChunk,
  toolActivity,
  type AgentHistoryModule,
  type HistoryLimitWindow,
  type HistoryRecord,
  type JsonObject,
  type ParseState,
} from '@agentbox/core';

/** `agentbox-history/<uuid>.index.jsonl`: this session's `session_index.jsonl` rows. */
const INDEX_FILE = /(?:^|\/)([^/]+)\.index\.jsonl$/;

const ROLLOUT_ID =
  /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

/** A user-role message codex wrote itself (environment, AGENTS.md, permissions). */
function injected(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<') || t.startsWith('# AGENTS.md') || t.startsWith('AGENTS.md');
}

function contentText(content: unknown, type: string): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const o = asObject(b);
      return o && o.type === type && typeof o.text === 'string' ? o.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function parentOf(meta: JsonObject): string | undefined {
  const spawn = asObject(asObject(asObject(meta.source)?.subagent)?.thread_spawn);
  return (
    nonEmptyString(meta.forked_from_id) ??
    nonEmptyString(meta.parent_thread_id) ??
    nonEmptyString(spawn?.parent_thread_id)
  );
}

/**
 * A command's working-on line: codex's own parse of it (a read names its file),
 * else the argv. Either way only the program and a plain first argument of a
 * command are shown (`commandSummary`), never a script, heredoc or env value.
 */
function commandActivity(p: JsonObject): string {
  if (Array.isArray(p.parsed_cmd)) {
    for (const c of p.parsed_cmd) {
      const o = asObject(c);
      const type = nonEmptyString(o?.type) ?? 'exec';
      const name = nonEmptyString(o?.name);
      if (type === 'read' && name) return toolActivity(type, { path: name });
      const cmd = nonEmptyString(o?.cmd);
      if (cmd) return toolActivity(type, { command: cmd });
    }
  }
  const argv = Array.isArray(p.command) ? p.command : undefined;
  return argv ? toolActivity('exec', { command: argv }) : '';
}

/**
 * `token_count`: `total_token_usage` is the session's cumulative count;
 * `last_token_usage.input_tokens` against `model_context_window` is the
 * context fill.
 */
function tokenCountRecords(p: JsonObject, tsPart: { ts?: string }, at: number): HistoryRecord[] {
  const info = asObject(p.info);
  if (!info) return [];
  const out: HistoryRecord[] = [];
  const total = asObject(info.total_token_usage);
  if (total) {
    const cached = finiteNumber(total.cached_input_tokens);
    out.push({
      kind: 'totals',
      inputTokens: Math.max(0, finiteNumber(total.input_tokens) - cached),
      outputTokens: finiteNumber(total.output_tokens),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
      reasoningTokens: finiteNumber(total.reasoning_output_tokens),
      ...tsPart,
      at,
    });
  }
  const last = asObject(info.last_token_usage);
  const tokens = finiteNumber(last?.input_tokens);
  const window = finiteNumber(info.model_context_window);
  if (tokens > 0) {
    out.push({ kind: 'context', tokens, ...(window > 0 ? { window } : {}), ...tsPart, at });
  }
  return out;
}

/** One `rate_limits` window (`primary` / `secondary`); null or junk is no window. */
/**
 * One window. `resets_at` is unix seconds; older codex wrote only
 * `resets_in_seconds`, counted from the record's own timestamp.
 */
function limitWindow(id: string, raw: unknown, tsMs: number | null): HistoryLimitWindow | null {
  const w = asObject(raw);
  if (!w || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) return null;
  const minutes = finiteNumber(w.window_minutes);
  const inSeconds = finiteNumber(w.resets_in_seconds);
  const resets =
    finiteNumber(w.resets_at) ||
    (tsMs !== null && inSeconds > 0 ? Math.round(tsMs / 1000 + inSeconds) : 0);
  return {
    id,
    pct: Math.max(0, w.used_percent),
    ...(minutes > 0 ? { windowMinutes: minutes } : {}),
    ...(resets > 0 ? { resetsAt: new Date(resets * 1000).toISOString() } : {}),
  };
}

/**
 * `token_count.rate_limits`: the plan windows of the login the session runs
 * on (hub settings Phase 3b). A plan has the windows it has (Pro: weekly only,
 * `secondary: null`), so only the present ones are kept.
 */
function limitsRecords(p: JsonObject, tsPart: { ts?: string }, at: number): HistoryRecord[] {
  const rl = asObject(p.rate_limits);
  if (!rl) return [];
  const tsMs = tsPart.ts ? Date.parse(tsPart.ts) : NaN;
  const base = Number.isFinite(tsMs) ? tsMs : null;
  const windows = [
    limitWindow('primary', rl.primary, base),
    limitWindow('secondary', rl.secondary, base),
  ].filter((w): w is HistoryLimitWindow => w !== null);
  if (windows.length === 0) return [];
  const reached = nonEmptyString(rl.rate_limit_reached_type);
  const plan = nonEmptyString(rl.plan_type);
  return [
    {
      kind: 'limits',
      windows,
      ...(reached ? { reached } : {}),
      ...(plan ? { plan } : {}),
      ...tsPart,
      at,
    },
  ];
}

/** One `session_index.jsonl` row (copied by the row cursor): the session's name. */
function indexRecords(line: JsonObject, at: number): HistoryRecord[] {
  const row = asObject(line.row);
  const title =
    nonEmptyString(row?.thread_name) ?? nonEmptyString(row?.name) ?? nonEmptyString(row?.title);
  if (!title) return [];
  const ts = nonEmptyString(row?.updated_at);
  return [{ kind: 'meta', title, ...(ts ? { ts } : {}), at }];
}

/** Records for one rollout line at byte offset `at`. `state.model` tracks the turn's model. */
export function codexLineRecords(line: JsonObject, at: number, state: ParseState): HistoryRecord[] {
  const ts = nonEmptyString(line.timestamp);
  const p = asObject(line.payload);
  if (!p) return [];
  const tsPart = ts ? { ts } : {};
  switch (line.type) {
    case 'session_meta': {
      const cwd = nonEmptyString(p.cwd);
      return cwd ? [{ kind: 'meta', cwd, ...tsPart, at }] : [];
    }
    case 'turn_context': {
      const model = nonEmptyString(p.model);
      if (!model || model === state.model) return [];
      state.model = model;
      return [{ kind: 'meta', model, ...tsPart, at }];
    }
    case 'response_item': {
      if (p.type === 'message') {
        if (p.role === 'user') {
          const text = contentText(p.content, 'input_text').trim();
          if (!text || injected(text)) return [];
          return [{ kind: 'turn', role: 'user', text: clipText(text), ...tsPart, at }];
        }
        if (p.role === 'assistant') {
          const text = contentText(p.content, 'output_text').trim();
          if (!text) return [];
          const out: HistoryRecord[] = [
            { kind: 'turn', role: 'assistant', text: clipText(text), ...tsPart, at },
          ];
          // The progress notes codex writes between tool calls; the final
          // answer is not a working-on line.
          if (p.phase === 'commentary') {
            const line = activityLine(text);
            if (line) out.push({ kind: 'activity', text: line, ...tsPart, at });
          }
          return out;
        }
        return [];
      }
      if (typeof p.type === 'string' && p.type.endsWith('_call')) {
        const name = nonEmptyString(p.name) ?? p.type.slice(0, -'_call'.length);
        return [{ kind: 'tool', name, ...tsPart, at }];
      }
      return [];
    }
    case 'event_msg': {
      if (p.type === 'exec_command_begin') {
        const line = commandActivity(p);
        return line ? [{ kind: 'activity', text: line, ...tsPart, at }] : [];
      }
      if (p.type === 'token_count') {
        return [...tokenCountRecords(p, tsPart, at), ...limitsRecords(p, tsPart, at)];
      }
      return [];
    }
    case 'token_usage_record': {
      const usage = asObject(p.usage);
      const messageId = nonEmptyString(p.response_id);
      if (!usage || !messageId) return [];
      // OpenAI counts cached input inside input_tokens; the projection keeps
      // them apart, as claude reports them.
      const cached = finiteNumber(usage.cached_input_tokens);
      const model = typeof state.model === 'string' ? state.model : undefined;
      return [
        {
          kind: 'usage',
          messageId,
          ...(model ? { model } : {}),
          inputTokens: Math.max(0, finiteNumber(usage.input_tokens) - cached),
          outputTokens: finiteNumber(usage.output_tokens),
          cacheReadTokens: cached,
          cacheWriteTokens: finiteNumber(usage.cache_write_input_tokens),
          ...tsPart,
          at,
        },
      ];
    }
    default:
      return [];
  }
}

export const codexHistoryModule: AgentHistoryModule = {
  id: 'codex',
  // 2: working-on line, `token_count` totals and context, session names.
  // 3: `token_count.rate_limits` as a `limits` record.
  parserVersion: 3,

  identify(head, path) {
    const index = INDEX_FILE.exec(path);
    if (index) return { sessionId: index[1]!, child: true };
    const m = ROLLOUT_ID.exec(path);
    let sessionId = m?.[1];
    let parent: string | undefined;
    for (const line of headJsonLines(head, 5)) {
      if (line.type !== 'session_meta') continue;
      const meta = asObject(line.payload);
      if (!meta) break;
      sessionId ??= nonEmptyString(meta.id);
      parent = parentOf(meta);
      break;
    }
    if (!sessionId) return null;
    return parent && parent !== sessionId ? { sessionId, parentSessionId: parent } : { sessionId };
  },

  parse: (chunk, state) =>
    INDEX_FILE.test(chunk.path)
      ? parseJsonlChunk(chunk, state, indexRecords)
      : parseJsonlChunk(chunk, state, codexLineRecords),
};
