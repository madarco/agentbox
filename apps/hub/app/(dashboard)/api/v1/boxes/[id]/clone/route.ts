// POST /api/v1/boxes/:id/clone — a new box from this box's workspace files and
// its `agentbox.yaml`, with a FRESH agent identity (the agent's config volume
// and credential are deliberately not copied, so it onboards from scratch).
// Two steps, one route: `prepareClone` exports the workspace into a new host
// project dir, then the normal create enqueues the box. Returns the create job
// so the CLI, the web UI and the tray all stream the same progress.
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
    return fail('conflict', `box ${id} is still being created; clone is not available yet`);
  }
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const raw = await readJson(req);
  if (!raw.ok) return fail('invalid_request', raw.message);
  const body = (typeof raw.value === 'object' && raw.value !== null ? raw.value : {}) as {
    name?: unknown;
    provider?: unknown;
    into?: unknown;
    includeNodeModules?: unknown;
    persistent?: unknown;
  };
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;

  const prepared = await backend.prepareClone(id, {
    name: str(body.name),
    provider: str(body.provider),
    into: str(body.into),
    includeNodeModules: body.includeNodeModules === true,
    // TODO(plan phase 1): forward as `--persistent` on the create once
    // `BoxRecord.persistent` exists. Accepted here so the API shape is final.
    persistent: body.persistent !== false,
  });
  if (!prepared.ok) return failFromAction(prepared.error);

  const created = await backend.create({
    projectId: prepared.projectId,
    provider: prepared.provider,
    agent: 'none',
    name: prepared.name,
  });
  if (!created.ok) return failFromAction(created.error);
  return ok({
    jobId: created.jobId,
    name: prepared.name,
    workspace: prepared.workspace,
    provider: prepared.provider,
    files: prepared.files,
  });
}
