// POST /api/v1/boxes/:id/rename — set (or clear, with an empty string) a box's
// cosmetic display label. Pure state — the container/branch/URL are untouched.
// Mutations need the in-process host backend; the Postgres/plane path 503s.
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';
import { parseRenameBox, readJson } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  // Create jobs surface as synthetic `job:` boxes with no real record yet.
  if (id.startsWith('job:')) {
    return fail('conflict', `box ${id} is still being created; rename is not available yet`, {
      jobId: id.slice('job:'.length),
    });
  }
  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const parsed = parseRenameBox(parsedBody.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message, parsed.details);

  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const res = await backend.rename(id, parsed.value.displayName);
  if (!res.ok) return failFromAction(res.error);
  return ok({ ok: true });
}
