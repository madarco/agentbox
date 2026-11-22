// GET /api/v1/history/sessions/{ref} — one session, condensed: its row, its files
// (main + subagent children, with byte sizes), the turn count, tool-name counts,
// and the first user prompt and last assistant reply. `ref` is `<agent>:<id>`,
// a session id, or an id prefix of at least 8 characters (409 when ambiguous).
import { fail, ok } from '../../../lib/envelope';
import { historyOrFail, resolveOrFail, sessionJson } from '../../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ ref: string }> },
): Promise<Response> {
  const history = historyOrFail();
  if (history instanceof Response) return history;
  const key = await resolveOrFail(history, (await ctx.params).ref);
  if (key instanceof Response) return key;
  const d = await history.sessionDetail(key);
  if (!d) return fail('not_found', 'session not found');
  return ok({
    session: sessionJson(d.session),
    files: d.files,
    turns: d.turns,
    tools: d.tools,
    firstPrompt: d.firstPrompt,
    lastReply: d.lastReply,
  });
}
