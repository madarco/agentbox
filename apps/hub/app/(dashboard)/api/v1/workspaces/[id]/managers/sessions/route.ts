// GET /api/v1/workspaces/:id/managers/sessions — resumable agent sessions for the
// workspace folder, read from the agent's own on-disk store. Feeds the "resume a
// session" picker before a manager is started. `supported: false` means this
// agent's session format is not one we can resume, which is not an error.
import { backendOrNull } from '../../../../lib/backend';
import { fail, failFromManager, ok } from '../../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('not_found', `unknown workspace ${id}`);
  const agent = new URL(req.url).searchParams.get('agent') ?? undefined;
  const res = await backend.listManagerSessions(id, agent);
  if (!res) return fail('not_found', `unknown workspace ${id}`);
  if (!res.ok) return failFromManager(res);
  return ok(res.sessions);
}
