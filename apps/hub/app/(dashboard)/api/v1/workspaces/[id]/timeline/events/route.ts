// POST /api/v1/workspaces/:id/timeline/events — append one event a hub that does
// NOT hold the store produced: a PC hub's docker box lifecycle, its queue
// worker's `box.ready`, an in-box `git push` its relay saw. The store lives on
// the hub that owns the boxes, so those rows travel here or they are lost.
//
// 201 on append, 200 when the event's `key` was already in the log (a retried
// report lands once), 404 for a workspace this hub does not have.
import { backendOrNull } from '../../../../lib/backend';
import { fail, failFromAction, ok } from '../../../../lib/envelope';
import { parseTimelineEvent, readJson } from '../../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('not_found', `unknown workspace ${id}`);
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  const parsed = parseTimelineEvent(body.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);
  const res = await backend.recordTimelineEvent(id, parsed.value);
  if (!res) return fail('not_found', `unknown workspace ${id}`);
  if (!res.ok) return failFromAction(res.error);
  return res.event ? ok({ event: res.event }, 201) : ok({ deduped: true });
}
