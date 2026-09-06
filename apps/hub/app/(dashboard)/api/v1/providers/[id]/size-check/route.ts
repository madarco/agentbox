// POST /api/v1/providers/:id/size-check — would a box created at `size` actually
// get that size?
//
// Most backends apply a size per create and answer `{ rebakeRequired: false }`.
// Daytona and e2b fix CPU/memory when the base is baked and discard anything
// else, so they answer true with the sentence to show the user. That is what
// lets a create form re-bake only when the size really differs from the baked
// one, instead of firing a 2-10 minute bake on every size change.
//
// Advisory, so it never fails the caller: an unresolvable provider or a backend
// without the hook answers false rather than erroring.
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';
import { isProviderId, parseSizeCheck } from '../../../lib/validate';

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
  const parsed = parseSizeCheck(body);
  if (!parsed.ok) return fail('invalid_request', parsed.message, parsed.details);

  return ok(await backend.checkProviderSize(id, parsed.value));
}
