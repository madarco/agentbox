/**
 * Claude's session-history parser (docs/agent-history-plan.md, Phase 0 "claude").
 *
 * - The session id is the FILE STEM. A file's first lines can carry another id
 *   (a desktop continuation copies its parent's lines), so the head names the
 *   parent, never the session.
 * - `/branch` writes a new file whose lines carry `forkedFrom.sessionId`.
 * - `<id>/subagents/agent-*.jsonl` are children of session `<id>`.
 */
import type { AgentHistoryModule, HistoryRecord, ParseState } from '@agentbox/core';

const SUBAGENT_PATH = /(?:^|\/)([^/]+)\/subagents\/[^/]+\.jsonl$/;
const TEXT_MAX = 8_000;
const HEAD_LINES = 200;

type Json = Record<string, unknown>;

function asObj(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function clip(s: string): string {
  return s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}…` : s;
}

function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
}

function textBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const o = asObj(b);
      return o?.type === 'text' && typeof o.text === 'string' ? o.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** The session a file's own lines belong to: its stem, or a subagent's parent dir. */
function fileSessionId(path: string): string {
  return SUBAGENT_PATH.exec(path)?.[1] ?? stemOf(path);
}

/**
 * Records for one parsed line at byte offset `at`. With `sessionId` (the
 * file's session), usage on a line copied from another session (a `/branch`
 * copy carries `forkedFrom`, a desktop continuation the parent's id) is
 * dropped: the parent session already counted it.
 */
export function claudeLineRecords(line: Json, at: number, sessionId?: string): HistoryRecord[] {
  const ts = str(line.timestamp);
  const out: HistoryRecord[] = [];
  const type = line.type;
  if (type === 'custom-title') {
    const title = str(line.customTitle) ?? str(line.title);
    if (title) out.push({ kind: 'meta', title, ...(ts ? { ts } : {}), at });
    return out;
  }
  const message = asObj(line.message);
  if (!message) return out;
  if (type === 'user') {
    if (line.isMeta === true) return out;
    const text = textBlocks(message.content).trim();
    if (text) out.push({ kind: 'turn', role: 'user', text: clip(text), ...(ts ? { ts } : {}), at });
    return out;
  }
  if (type === 'assistant') {
    const text = textBlocks(message.content).trim();
    if (text) {
      out.push({ kind: 'turn', role: 'assistant', text: clip(text), ...(ts ? { ts } : {}), at });
    }
    if (Array.isArray(message.content)) {
      for (const b of message.content) {
        const o = asObj(b);
        const name = o?.type === 'tool_use' ? str(o.name) : undefined;
        if (name) out.push({ kind: 'tool', name, ...(ts ? { ts } : {}), at });
      }
    }
    const usage = asObj(message.usage);
    const messageId = str(message.id);
    const lineSession = str(line.sessionId);
    const copied =
      sessionId !== undefined &&
      (line.forkedFrom !== undefined || (lineSession !== undefined && lineSession !== sessionId));
    if (usage && messageId && !copied) {
      const model = str(message.model);
      out.push({
        kind: 'usage',
        messageId,
        ...(model ? { model } : {}),
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
        cacheReadTokens: num(usage.cache_read_input_tokens),
        cacheWriteTokens: num(usage.cache_creation_input_tokens),
        ...(ts ? { ts } : {}),
        at,
      });
    }
  }
  return out;
}

export const claudeHistoryModule: AgentHistoryModule = {
  id: 'claude',
  // 2: usage on lines copied from another session is no longer counted.
  parserVersion: 2,

  identify(head, path) {
    const sub = SUBAGENT_PATH.exec(path);
    if (sub) return { sessionId: sub[1]!, child: true };
    const sessionId = stemOf(path);
    if (!sessionId) return null;
    let foreign: string | undefined;
    const lines = Buffer.from(head).toString('utf8').split('\n').slice(0, HEAD_LINES);
    for (const raw of lines) {
      let line: Json | undefined;
      try {
        line = asObj(JSON.parse(raw));
      } catch {
        continue;
      }
      if (!line) continue;
      const forked = str(asObj(line.forkedFrom)?.sessionId);
      if (forked && forked !== sessionId) return { sessionId, parentSessionId: forked };
      const sid = str(line.sessionId);
      if (sid && sid !== sessionId) foreign ??= sid;
    }
    return foreign ? { sessionId, parentSessionId: foreign } : { sessionId };
  },

  parse(chunk, state) {
    const carry = typeof state.partial === 'string' ? Buffer.from(state.partial, 'base64') : null;
    const buf = carry ? Buffer.concat([carry, Buffer.from(chunk.bytes)]) : Buffer.from(chunk.bytes);
    const base = chunk.offset - (carry?.length ?? 0);
    const records: HistoryRecord[] = [];
    const sessionId = fileSessionId(chunk.path);
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl === -1) break;
      const raw = buf.subarray(start, nl).toString('utf8');
      if (raw.trim()) {
        try {
          const line = asObj(JSON.parse(raw));
          if (line) records.push(...claudeLineRecords(line, base + start, sessionId));
        } catch {
          /* a non-JSON line is kept in raw, skipped here */
        }
      }
      start = nl + 1;
    }
    const next: ParseState = {};
    if (start < buf.length) next.partial = buf.subarray(start).toString('base64');
    return { records, state: next };
  },
};
