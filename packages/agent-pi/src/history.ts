/**
 * Pi's session-history parser (docs/agent-history-plan.md, Phase 0 "pi").
 *
 * A session is `sessions/--<cwd>--/<ts>_<uuid>.jsonl`: a `session` header
 * (`id`, `cwd`, `parentSession` = the parent's FILE path for `/fork` and
 * `/clone`), then tree entries linked by `id`/`parentId`. `/tree` branches stay
 * in the same file, so every entry is projected in file order. Usage is on
 * any entry that carries one (assistant and tool-result messages, compaction
 * and branch summaries: `message.usage` or `usage`), keyed by the entry id;
 * the sum matches pi's own footer.
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
  type HistoryRecord,
  type JsonObject,
  type ParseState,
} from '@agentbox/core';

/** `<ts>_<uuid>.jsonl` → uuid (the default id; `--session-id` may set any). */
function idFromName(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (!base.endsWith('.jsonl')) return undefined;
  const stem = base.slice(0, -'.jsonl'.length);
  const us = stem.indexOf('_');
  return us === -1 ? undefined : nonEmptyString(stem.slice(us + 1));
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

/**
 * An assistant message that ended on a refused credential (measured
 * 2026-11-28, a bogus Anthropic key): `stopReason: "error"` and an
 * `errorMessage` that starts with the provider's 401. Only the shape is kept,
 * never the message.
 */
function piRefused(m: JsonObject): boolean {
  if (m.stopReason !== 'error' || typeof m.errorMessage !== 'string') return false;
  return /^\s*401\b/.test(m.errorMessage) || m.errorMessage.includes('"authentication_error"');
}

/** A line older than its session's header: carried over from a parent by `/fork`. */
function copiedLine(ts: string | undefined, state: ParseState): boolean {
  const start = typeof state.startedAt === 'string' ? Date.parse(state.startedAt) : NaN;
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(start) && Number.isFinite(t) && t < start;
}

/** Records for one session line at byte offset `at`. */
export function piLineRecords(line: JsonObject, at: number, state: ParseState): HistoryRecord[] {
  const ts = nonEmptyString(line.timestamp);
  const tsPart = ts ? { ts } : {};
  const usage = usageRecord(line, at, tsPart);
  return usage
    ? [...entryRecords(line, at, state, tsPart), usage]
    : entryRecords(line, at, state, tsPart);
}

function usageRecord(line: JsonObject, at: number, tsPart: { ts?: string }): HistoryRecord | null {
  const m = asObject(line.message);
  const usage = asObject(m?.usage) ?? asObject(line.usage);
  const messageId = nonEmptyString(line.id);
  if (!usage || !messageId) return null;
  const model = nonEmptyString(m?.responseModel) ?? nonEmptyString(m?.model);
  const cost = finiteNumber(asObject(usage.cost)?.total);
  return {
    kind: 'usage',
    messageId,
    ...(model ? { model } : {}),
    inputTokens: finiteNumber(usage.input),
    outputTokens: finiteNumber(usage.output),
    cacheReadTokens: finiteNumber(usage.cacheRead),
    cacheWriteTokens: finiteNumber(usage.cacheWrite),
    ...(cost > 0 ? { costUsd: cost } : {}),
    ...tsPart,
    at,
  };
}

function entryRecords(
  line: JsonObject,
  at: number,
  state: ParseState,
  tsPart: { ts?: string },
): HistoryRecord[] {
  if (line.type === 'session') {
    if (tsPart.ts && typeof state.startedAt !== 'string') state.startedAt = tsPart.ts;
    const cwd = nonEmptyString(line.cwd);
    return cwd ? [{ kind: 'meta', cwd, ...tsPart, at }] : [];
  }
  if (line.type === 'session_info') {
    const title = nonEmptyString(line.name);
    return title ? [{ kind: 'meta', title, ...tsPart, at }] : [];
  }
  if (line.type === 'model_change') {
    const model = nonEmptyString(line.modelId);
    if (!model || model === state.model) return [];
    state.model = model;
    return [{ kind: 'meta', model, ...tsPart, at }];
  }
  if (line.type !== 'message') return [];
  const m = asObject(line.message);
  if (!m) return [];
  if (m.role === 'user') {
    const t = text(m.content).trim();
    return t ? [{ kind: 'turn', role: 'user', text: clipText(t), ...tsPart, at }] : [];
  }
  if (m.role !== 'assistant') return [];
  const out: HistoryRecord[] = [];
  if (piRefused(m) && !copiedLine(tsPart.ts, state)) {
    out.push({ kind: 'auth', error: 'unauthorized', ...tsPart, at });
  }
  const t = text(m.content).trim();
  if (t) out.push({ kind: 'turn', role: 'assistant', text: clipText(t), ...tsPart, at });
  let activity = t ? activityLine(t) : '';
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      const o = asObject(b);
      const name = o?.type === 'toolCall' ? nonEmptyString(o.name) : undefined;
      if (!name) continue;
      out.push({ kind: 'tool', name, ...tsPart, at });
      activity = toolActivity(name, o?.arguments);
    }
  }
  if (activity) out.push({ kind: 'activity', text: activity, ...tsPart, at });
  return out;
}

export const piHistoryModule: AgentHistoryModule = {
  id: 'pi',
  // 2: usage on every entry kind (was assistant messages only), cost, the
  // working-on line.
  parserVersion: 2,

  identify(head, path) {
    const header = headJsonLines(head, 1)[0];
    const sessionId =
      (header?.type === 'session' ? nonEmptyString(header.id) : undefined) ?? idFromName(path);
    if (!sessionId) return null;
    const parentPath =
      header?.type === 'session' ? nonEmptyString(header.parentSession) : undefined;
    const parent = parentPath ? idFromName(parentPath) : undefined;
    return parent && parent !== sessionId ? { sessionId, parentSessionId: parent } : { sessionId };
  },

  parse: (chunk, state) => parseJsonlChunk(chunk, state, piLineRecords),
};
