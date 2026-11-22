// GET /api/v1/history/sessions — sessions, newest activity first.
//   Filters: agent, box (id or name), project (repo URL substring), host (machine
//   id), since (ISO timestamp), q (full-text over turns), limit (default 50, max 500).
import { fail, ok } from '../../lib/envelope';
import { historyOrFail, intParam, sessionJson } from '../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const history = historyOrFail();
  if (history instanceof Response) return history;
  const p = new URL(req.url).searchParams;
  const limit = intParam(p.get('limit'), 50, 1);
  if (limit === null) return fail('invalid_request', 'limit must be a positive integer');
  const since = p.get('since');
  const sinceMs = since ? Date.parse(since) : undefined;
  if (sinceMs !== undefined && Number.isNaN(sinceMs)) {
    return fail('invalid_request', 'since must be an ISO-8601 timestamp');
  }
  const str = (k: string): string | undefined => p.get(k)?.trim() || undefined;
  const sessions = await history.listSessions({
    ...(str('agent') ? { agent: str('agent') } : {}),
    ...(str('box') ? { box: str('box') } : {}),
    ...(str('project') ? { project: str('project') } : {}),
    ...(str('host') ? { host: str('host') } : {}),
    ...(str('q') ? { q: str('q') } : {}),
    ...(sinceMs !== undefined ? { sinceMs } : {}),
    limit,
  });
  return ok({ sessions: sessions.map(sessionJson) });
}
