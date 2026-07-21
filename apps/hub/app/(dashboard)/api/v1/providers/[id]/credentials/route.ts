// POST /api/v1/providers/:id/credentials — persist a provider's credentials
// (API keys/tokens) to ~/.agentbox/secrets.env after validating them against the
// cloud. Mutations need the in-process host backend; the Postgres/plane path 503s.
// The response never echoes secret values.
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';
import { isProviderId, parseProviderCredentials } from '../../../lib/validate';

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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('invalid_request', 'body must be valid JSON');
  }
  const parsed = parseProviderCredentials(body);
  if (!parsed.ok) return fail('invalid_request', parsed.message, parsed.details);

  const res = await backend.setProviderCredentials(id, parsed.value);
  // Credential problems (unknown provider, rejected token) are client-input
  // errors → 400, never a 5xx.
  if (!res.ok) return fail('invalid_request', res.error);
  return ok({ ok: true });
}
