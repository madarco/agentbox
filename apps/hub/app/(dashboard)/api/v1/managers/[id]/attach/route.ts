// POST /api/v1/managers/:id/attach — open a claude manager's Claude background
// session (`claude attach <id>`) in a tmux session the hub owns, so any client can
// attach to it. The record stays as detected; the session keeps running in
// Claude's daemon when that tmux session ends. 409 unless the session is running
// in the daemon and nothing the hub can see already shows it; 503 without tmux.
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromManager, ok } from '../../../lib/envelope';
import { TMUX_MISSING } from '@/lib/backend/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const res = await backend.attachManager(id);
  if (!res.ok) {
    if (res.error === TMUX_MISSING) return fail('backend_unavailable', res.error);
    return failFromManager(res);
  }
  return ok(res.manager);
}
