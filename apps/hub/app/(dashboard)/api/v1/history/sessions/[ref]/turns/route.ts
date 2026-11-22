// GET /api/v1/history/sessions/{ref}/turns?from&to — the session's turn and tool
// rows in order, `from` (default 0) to `to` inclusive (default from+199, at most
// 1000 rows per call). Each row names the file it came from.
import { fail, ok } from '../../../../lib/envelope';
import { historyOrFail, intParam, resolveOrFail } from '../../../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ ref: string }> },
): Promise<Response> {
  const history = historyOrFail();
  if (history instanceof Response) return history;
  const key = await resolveOrFail(history, (await ctx.params).ref);
  if (key instanceof Response) return key;
  const p = new URL(req.url).searchParams;
  const from = intParam(p.get('from'), 0);
  const to = intParam(p.get('to'), (from ?? 0) + 199);
  if (from === null || to === null || to < from) {
    return fail('invalid_request', 'from/to must be non-negative integers with to >= from');
  }
  const turns = await history.sessionTurns(key, from, to - from + 1);
  return ok({ turns });
}
