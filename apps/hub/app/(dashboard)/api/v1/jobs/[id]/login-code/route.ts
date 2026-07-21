// POST /api/v1/jobs/:id/login-code — deliver the pasted OAuth approval code to a
// create job that is awaiting a Claude re-login. Writes it onto the job manifest;
// the create worker consumes it and feeds it to the login container. In-process
// backend only (the queue is a local-host concern).
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';
import { parseLoginCode, readJson } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const parsed = parseLoginCode(parsedBody.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const res = await backend.submitLoginCode(id, parsed.value.code);
  if (!res.ok) return failFromAction(res.error);
  return ok({ ok: true });
}
