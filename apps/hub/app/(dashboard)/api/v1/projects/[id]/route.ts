// DELETE /api/v1/projects/:id — unregister an empty project (zero boxes). The
// folder/files on disk are untouched; only the hub registry entry is removed.
// Mutations need the in-process host backend; the Postgres/plane path 503s
// (hosted writes are a documented follow-up).
import { backendOrNull, readState } from '../../lib/backend';
import { fail, failFromAction, ok } from '../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  // The backend's remove is idempotent (ok even when nothing was registered), so
  // check existence here to answer a genuinely-unknown id with 404.
  const { projects } = await readState();
  if (!projects.some((p) => p.id === id)) return fail('not_found', `unknown project ${id}`);

  const res = await backend.removeProject(id);
  if (!res.ok) return failFromAction(res.error); // "project has boxes; …" -> 409 conflict
  return ok({ ok: true });
}
