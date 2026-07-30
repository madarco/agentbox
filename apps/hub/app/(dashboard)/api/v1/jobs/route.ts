// GET /api/v1/jobs — the unified background-job listing (`agentbox queue list` /
// `agentbox hub jobs`). Merges the local file queue's create jobs with, on a
// control box, the control-plane create queue. In-process backend only.
import { backendOrNull } from '../lib/backend';
import { fail, ok } from '../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const jobs = await backend.listJobs();
  return ok({ jobs });
}
