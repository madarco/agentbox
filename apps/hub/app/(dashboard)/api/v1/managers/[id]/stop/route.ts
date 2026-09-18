// POST /api/v1/managers/:id/stop — kill a hub-run manager's tmux session.
// Idempotent, and the record is kept so it can be resumed. An external manager
// is the user's own terminal process, which the hub never signals (409 while it runs).
// A claude manager whose session runs in Claude's background daemon only loses
// the hub's attach session: the answer carries `notice` saying the session lives on.
import { backendOrNull } from '../../../lib/backend';
import { timelineMeta } from '../../../lib/actor';
import { fail, failFromManager, ok } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const res = await backend.stopManager(id, await timelineMeta(req, backend));
  if (!res.ok) return failFromManager(res);
  return ok(res.notice ? { ...res.manager, notice: res.notice } : res.manager);
}
