// GET /api/v1/projects/:id/branches — the project's branches (local + remote)
// plus its current HEAD, for the create-box base-branch picker. Needs the
// in-process host backend (reads the local repo); the Postgres/plane path has no
// local repo, so it 503s there.
import { backendOrNull, readState } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const { projects } = await readState();
  if (!projects.some((p) => p.id === id)) return fail('not_found', `unknown project ${id}`);

  const res = await backend.listBranches(id);
  if (!res.ok) return fail('invalid_request', res.error);
  return ok({ current: res.current, branches: res.branches });
}
