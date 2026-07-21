// POST /api/v1/boxes/:id/services/restart — restart one service (body `{name}`)
// or every service (empty body). Mutations need the in-process backend.
import { backendOrNull } from '../../../../lib/backend';
import { fail, failFromAction, ok } from '../../../../lib/envelope';
import { parseServiceRestart, readJson } from '../../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (id.startsWith('job:')) {
    return fail('conflict', `box ${id} is still being created; services are not available yet`, {
      jobId: id.slice('job:'.length),
    });
  }
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const parsed = parseServiceRestart(parsedBody.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message, parsed.details);

  const res = await backend.restartService(id, parsed.value.name);
  if (!res.ok) return failFromAction(res.error);
  return ok({ ok: true });
}
