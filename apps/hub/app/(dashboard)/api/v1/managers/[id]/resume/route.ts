// POST /api/v1/managers/:id/resume — reopen a stopped manager's session in a
// tmux session the hub owns, with the agent's own resume spelling. This is what
// turns "the terminal session that made these boxes" into a manager any client
// can attach to. 409 while the session still runs anywhere; 503 without tmux.
import { backendOrNull } from '../../../lib/backend';
import { timelineMeta } from '../../../lib/actor';
import { fail, failFromManager, ok } from '../../../lib/envelope';
import { MANAGER_CARRIER_MISSING, PTY_CARRIER_MISSING, TMUX_MISSING } from '@/lib/backend/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const res = await backend.resumeManager(id, await timelineMeta(req, backend));
  if (!res.ok) {
    if (
      res.error === TMUX_MISSING ||
      res.error === MANAGER_CARRIER_MISSING ||
      res.error === PTY_CARRIER_MISSING
    ) {
      return fail('backend_unavailable', res.error);
    }
    return failFromManager(res);
  }
  return ok(res.manager);
}
