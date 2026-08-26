// GET /api/v1/projects/:id/seed — the project's seed / custody status on the
// control box: what `agentbox hub project push` stored (untracked + env/secret
// tarballs + a manifest), as paths, hashes and timestamps only. Never returns
// seed contents. Reads only, so it works across topologies; a hub that is not a
// control box (no custody store) answers `{ custodyAvailable: false }`.
import { readState } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';
import { getProjectSeedStatus, seedSlugFor } from '@/lib/boxes/seed-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const { projects } = await readState();
  const project = projects.find((p) => p.id === id);
  if (!project) return fail('not_found', `unknown project ${id}`);

  const slug = seedSlugFor(project);
  const status = await getProjectSeedStatus(slug);
  return ok(status);
}
