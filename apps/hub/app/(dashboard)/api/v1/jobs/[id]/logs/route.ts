// GET /api/v1/jobs/:id/logs — stream a create-job log (SSE: open, log*, end).
// Delegates to the shared tail in lib/job-log-stream.ts (same impl as the internal
// /api/jobs/:id/logs route the create-box modal uses).
import { streamJobLog } from '@/lib/job-log-stream';
import { backendOrNull } from '../../../lib/backend';
import { fail } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const job = await backend.getJob(id);
  if (!job) return fail('not_found', `job not found: ${id}`);
  return streamJobLog(req, id, backend, job.logPath);
}
