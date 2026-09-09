// POST /api/v1/projects/:id/restore — bring a backed-up bot back as a NEW box,
// identity included.
//
// Project-scoped rather than box-scoped because the bundle outlives the box it
// came from — that is what a backup is for — so there is usually no box to hang
// this off. The project is what still exists.
//
// Two steps, one route, exactly like `clone`: `prepareRestore` resolves the
// bundle, refuses what must not happen (the source box still running, a
// destination a box already occupies) and stages the workspace half; then the
// ordinary create is enqueued. The STATE half rides `opts.restore` and is applied
// by the queue worker once the box's service has come up on its own. Returns the
// create job so the CLI, the web UI and the tray stream the same progress.
import { restoreCreateInput } from '@/lib/boxes/restore-create';
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';
import { parseRestoreProject, readJson } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const raw = await readJson(req);
  if (!raw.ok) return fail('invalid_request', raw.message);
  const parsed = parseRestoreProject(raw.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message, parsed.details);

  const prepared = await backend.prepareRestore(id, parsed.value);
  if (!prepared.ok) return failFromAction(prepared.error);

  const created = await backend.create(restoreCreateInput(prepared));
  if (!created.ok) return failFromAction(created.error);
  return ok({
    jobId: created.jobId,
    name: prepared.name,
    workspace: prepared.workspace,
    provider: prepared.provider,
    bot: prepared.bot,
    stamp: prepared.stamp,
    agent: prepared.agent,
    files: prepared.files,
    ...(prepared.persistent !== undefined ? { persistent: prepared.persistent } : {}),
  });
}
