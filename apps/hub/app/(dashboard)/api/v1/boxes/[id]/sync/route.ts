// POST /api/v1/boxes/:id/sync — push the host workspace into the live box
// (`agentbox sync`). Git workspaces merge + overlay; non-git ones get a file
// overlay. The BOX wins every conflict, so this never destroys in-box work; the
// skipped host paths come back in `conflicts`.
// Needs the in-process host backend (it reads host files); the Postgres/plane
// path 503s.
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';
import { readJson } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (id.startsWith('job:')) {
    return fail('conflict', `box ${id} is still being created; sync is not available yet`);
  }
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const raw = await readJson(req);
  if (!raw.ok) return fail('invalid_request', raw.message);
  const body = (typeof raw.value === 'object' && raw.value !== null ? raw.value : {}) as {
    includeNodeModules?: unknown;
  };

  const res = await backend.syncBox(id, {
    includeNodeModules: body.includeNodeModules === true,
  });
  if (!res.ok) return failFromAction(res.error);
  return ok({ mode: res.mode, copied: res.copied, conflicts: res.conflicts });
}
