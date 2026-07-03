// GET /api/v1/jobs/:id — create-job status. In-process backend only (the queue is
// a laptop/hetzner concern; hosted jobs are a follow-up).
import { backendOrNull } from '../../lib/backend';
import { fail, ok } from '../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const job = await backend.getJob(id);
  if (!job) return fail('not_found', `job not found: ${id}`);
  return ok({ id, status: job.status, ...(job.boxId ? { boxId: job.boxId } : {}) });
}
