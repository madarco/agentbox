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
  asObject,
  clipText,
  finiteNumber,
  headJsonLines,
  nonEmptyString,
  parseJsonlChunk,
  type AgentHistoryModule,
  type HistoryRecord,
  type JsonObject,
  type ParseState,
} from '@agentbox/core';

const ROLLOUT_ID = /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

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
          return text ? [{ kind: 'turn', role: 'assistant', text: clipText(text), ...tsPart, at }] : [];
        }
        return [];
      }
      if (typeof p.type === 'string' && p.type.endsWith('_call')) {
        const name = nonEmptyString(p.name) ?? p.type.slice(0, -'_call'.length);
        return [{ kind: 'tool', name, ...tsPart, at }];
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
  parserVersion: 1,

  identify(head, path) {
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

  parse: (chunk, state) => parseJsonlChunk(chunk, state, codexLineRecords),
};
