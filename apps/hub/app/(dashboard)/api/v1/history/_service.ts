// Shared by the /api/v1/history routes: the service the custom server built,
// the wire shape of a session, and reference resolution.
import type { HistoryService, HistorySessionRow } from '@/lib/backend/history';
import { fail } from '../lib/envelope';

export function historyOrFail(): HistoryService | Response {
  const history = globalThis.__AGENTBOX_HUB_HISTORY;
  if (!history) return fail('backend_unavailable', 'session history is not enabled on this hub');
  return history;
}

/** The wire shape: epoch-ms fields as ISO strings. */
export function sessionJson(s: HistorySessionRow): Record<string, unknown> {
  return {
    id: s.sessionId,
    key: s.key,
    agent: s.agent,
    boxId: s.boxId,
    boxName: s.boxName,
    provider: s.provider,
    hostId: s.hostId,
    projectRepoUrl: s.projectRepoUrl,
    parentSessionId: s.parentSessionId,
    title: s.title,
    firstTs: s.firstTs,
    lastTs: s.lastTs,
    turns: s.turns,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    createdAt: new Date(s.createdAt).toISOString(),
    updatedAt: new Date(s.updatedAt).toISOString(),
  };
}

/** `{ref}` → a session key, or the 404 / 409 to answer. */
export async function resolveOrFail(
  history: HistoryService,
  ref: string,
): Promise<string | Response> {
  const r = await history.resolveSession(decodeURIComponent(ref));
  if (r.ok) return r.key;
  return r.code === 'ambiguous'
    ? fail('conflict', `session reference "${ref}" matches several sessions`, {
        candidates: r.candidates,
      })
    : fail('not_found', `no session matches "${ref}"`);
}

export function intParam(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
