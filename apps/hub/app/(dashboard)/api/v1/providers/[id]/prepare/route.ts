// POST /api/v1/providers/:id/prepare — bake a provider's base image. Async: it
// enqueues a background prepare job and returns { jobId } with 202; progress
// streams over GET /api/v1/jobs/:id/logs (same channel as create). Mutations need
// the in-process host backend; the Postgres/plane path 503s.
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';
import { isProviderId, parseProviderPrepare } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!isProviderId(id)) return fail('invalid_request', `unknown provider: ${id}`);
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  // Body is optional (bake with defaults); tolerate an empty/absent one.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = undefined;
  }
  const parsed = parseProviderPrepare(body);
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const res = await backend.prepareProvider(id, parsed.value);
  // Precheck failures (docker daemon down, missing creds, missing ssh) → 409.
  if (!res.ok) return failFromAction(res.error);
  return ok({ jobId: res.jobId }, 202);
}
