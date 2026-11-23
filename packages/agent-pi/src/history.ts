/**
 * Pi's session-history parser (docs/agent-history-plan.md, Phase 0 "pi").
 *
 * A session is `sessions/--<cwd>--/<ts>_<uuid>.jsonl`: a `session` header
 * (`id`, `cwd`, `parentSession` = the parent's FILE path for `/fork` and
 * `/clone`), then tree entries linked by `id`/`parentId`. `/tree` branches stay
 * in the same file, so every entry is projected in file order. Usage is on
 * assistant messages (`message.usage`), keyed by the entry id.
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

/** Records for one session line at byte offset `at`. */
export function piLineRecords(line: JsonObject, at: number, state: ParseState): HistoryRecord[] {
  const ts = nonEmptyString(line.timestamp);
  const tsPart = ts ? { ts } : {};
  if (line.type === 'session') {
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
  const messageId = nonEmptyString(line.id);
  if (usage && messageId) {
    const model = nonEmptyString(m.responseModel) ?? nonEmptyString(m.model);
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

export const piHistoryModule: AgentHistoryModule = {
  id: 'pi',
  parserVersion: 1,

  identify(head, path) {
    const header = headJsonLines(head, 1)[0];
    const sessionId =
      (header?.type === 'session' ? nonEmptyString(header.id) : undefined) ?? idFromName(path);
    if (!sessionId) return null;
    const parentPath = header?.type === 'session' ? nonEmptyString(header.parentSession) : undefined;
    const parent = parentPath ? idFromName(parentPath) : undefined;
    return parent && parent !== sessionId ? { sessionId, parentSessionId: parent } : { sessionId };
  },

  parse: (chunk, state) => parseJsonlChunk(chunk, state, piLineRecords),
};
