// POST /api/v1/hosts/:alias/bake — bake the box image on this host. Async: returns
// a jobId; progress streams over GET /jobs/{id}/logs, exactly like a provider bake.
// A pull from GHCR is fast; a registry-miss build streams the context and is slow.
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ alias: string }> },
): Promise<Response> {
  const { alias } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const res = await backend.bakeRemoteDockerHost(alias);
  if (!res.ok) return failFromAction(res.error); // "no such host alias" -> 404
  return ok({ jobId: res.jobId }, 202);
}
