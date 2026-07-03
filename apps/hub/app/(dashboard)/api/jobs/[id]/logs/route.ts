// Per-job log SSE. The create-box modal opens an EventSource here after
// submitting; we tail the queue worker's per-job log file
// (`~/.agentbox/logs/queue-<id>.log`) and stream appended lines as `log` events,
// then a terminal `end` event when the job reaches done/failed/cancelled.
//
// Same-origin Next route gated by proxy.ts (the token/session cookie rides
// along), like /api/events. The log path + status come from the in-process hub
// backend (globalThis) so this route never imports the relay/sandbox toolchain —
// it only does plain fs reads. The streaming itself lives in lib/job-log-stream.ts,
// shared with the public /api/v1/jobs/[id]/logs route.
import { streamJobLog } from '@/lib/job-log-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = globalThis.__AGENTBOX_HUB_BACKEND;
  if (!backend) {
    return new Response('hub backend unavailable', { status: 503 });
  }
  const job = await backend.getJob(id);
  if (!job) {
    return new Response('job not found', { status: 404 });
  }
  return streamJobLog(req, id, backend, job.logPath);
}
