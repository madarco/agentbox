// POST /api/v1/projects/:id/create-preflight — what would creating a box here ask
// the user? Returns the questions (`PromptRequest[]`) a client renders before it
// POSTs /api/v1/boxes, plus the gates this hub cannot run and why.
//
// The questions come from running the REAL gates with a collecting asker, so a
// client can never be shown a set that differs from what the create asks.
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';
import { parseCreatePreflight, readJson } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const parsed = parseCreatePreflight(parsedBody.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const res = await backend.createPreflight({ ...parsed.value, projectId: id });
  return ok(res);
}
