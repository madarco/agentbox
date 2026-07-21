// GET /api/v1/boxes/:id/branches — the branches of the box's project repo (local
// + remote) plus its current HEAD, for the box git-panel branch picker. Resolves
// the box to its project and reuses the same host-repo branch list the create
// picker uses. Needs the in-process host backend (reads the local repo); the
// Postgres/plane path has no local repo, so it 503s there.
import { backendOrNull, readState } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const { boxes } = await readState();
  const box = boxes.find((b) => b.id === id);
  if (!box) return fail('not_found', `unknown box ${id}`);

  const res = await backend.listBranches(box.projectId);
  if (!res.ok) return fail('invalid_request', res.error);
  return ok({ current: res.current, branches: res.branches });
}
