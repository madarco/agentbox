// POST /api/v1/approvals/:id/answer — resolve a pending approval ({ answer: 'y'|'n' }).
// Unblocks the parked in-box RPC. In-process backend only (block-mode mailbox).
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';
import { parseAnswer, readJson } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const parsed = parseAnswer(parsedBody.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const res = await backend.answerApproval(id, parsed.value.answer, parsed.value.openedByClient);
  if (!res.ok) return failFromAction(res.error);
  return ok({ ok: true });
}
