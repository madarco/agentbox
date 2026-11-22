// GET /api/v1/history/sessions/{ref}/raw?path= — one transcript file of the
// session, streamed and byte-identical to what the edge shipped (redactions keep
// the length). Default: the session's main file; `path` picks a subagent file by
// the agent-relative path the detail route lists. Headers name the file.
import { fail } from '../../../../lib/envelope';
import { historyOrFail, resolveOrFail } from '../../../_service';

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
  const path = new URL(req.url).searchParams.get('path') ?? undefined;
  const file = await history.sessionFile(key, path || undefined);
  if (!file)
    return fail('not_found', path ? `the session has no file ${path}` : 'the session has no files');
  // One fixed length for the header and the body: the file may still grow.
  const iter = history.rawStream(file.id, file.offset);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iter.next();
        if (next.done) controller.close();
        else controller.enqueue(new Uint8Array(next.value));
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await iter.return(undefined);
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson',
      'content-length': String(file.offset),
      'x-agentbox-history-path': file.path,
    },
  });
}
