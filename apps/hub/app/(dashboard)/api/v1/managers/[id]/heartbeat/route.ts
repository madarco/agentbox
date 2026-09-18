// POST /api/v1/managers/:id/heartbeat — what the machine a manager runs on sees
// right now: its status, session, title, turn, exit code and background session.
//
// A hub that only holds the record cannot probe a pid, a tmux server or a
// transcript on another machine, so this is the only liveness it has. Refused
// (409) for a record whose `host` is this hub's own: there the process IS
// readable, and believing a report would let a stale claim override it.
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromManager, ok } from '../../../lib/envelope';
import { parseManagerHeartbeat, readJson } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  const parsed = parseManagerHeartbeat(body.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);
  const res = await backend.reportManager(id, parsed.value);
  if (!res.ok) return failFromManager(res);
  return ok(res.manager);
}
