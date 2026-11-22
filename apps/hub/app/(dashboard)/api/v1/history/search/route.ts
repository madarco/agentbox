// GET /api/v1/history/search?q&limit — turns matching all the words in `q`, best
// first, each with a snippet (matches in [brackets]) and the session it belongs
// to. `q` is plain words, never query syntax. limit default 20, max 200.
import { fail, ok } from '../../lib/envelope';
import { historyOrFail, intParam } from '../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const history = historyOrFail();
  if (history instanceof Response) return history;
  const p = new URL(req.url).searchParams;
  const q = p.get('q')?.trim() ?? '';
  if (!q) return fail('invalid_request', 'q is required');
  const limit = intParam(p.get('limit'), 20, 1);
  if (limit === null) return fail('invalid_request', 'limit must be a positive integer');
  const hits = await history.search(q, limit);
  const sessions = new Map<string, Record<string, unknown>>();
  for (const h of hits) {
    if (sessions.has(h.sessionKey)) continue;
    const s = await history.repo.getSession(h.sessionKey);
    if (s) {
      sessions.set(h.sessionKey, {
        id: s.sessionId,
        agent: s.agent,
        boxName: s.boxName,
        title: s.title,
      });
    }
  }
  return ok({
    hits: hits.map((h) => ({
      session: sessions.get(h.sessionKey) ?? { key: h.sessionKey },
      role: h.role,
      ts: h.ts,
      snippet: h.snippet,
    })),
  });
}
