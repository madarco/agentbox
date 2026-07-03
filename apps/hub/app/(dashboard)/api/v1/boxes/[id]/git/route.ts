// GET /api/v1/boxes/:id/git — live git summary (current branch, dirty, ahead/behind).
// Needs the in-process backend (runs `git status` in the box); the Postgres path 503s.
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const info = await backend.getGit(id);
  if (!info.ok) return fail('not_found', info.error ?? 'could not read git status');
  return ok(info);
}
