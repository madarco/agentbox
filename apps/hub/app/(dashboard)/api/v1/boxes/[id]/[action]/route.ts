// POST /api/v1/boxes/:id/:action — lifecycle: start | pause | resume | stop |
// destroy | screen.
// Mutations need the in-process host backend; the Postgres/plane path 503s (hosted
// writes are a documented follow-up).
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';
import { isLifecycleAction, LIFECYCLE_ACTIONS, readJson } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; action: string }> },
): Promise<Response> {
  const { id, action } = await ctx.params;
  if (!isLifecycleAction(action)) {
    return fail('invalid_request', `unknown action: ${action}`, {
      allowed: [...LIFECYCLE_ACTIONS],
    });
  }
  // In-flight create jobs surface in GET /boxes as synthetic `creating`/`error`
  // boxes with a `job:` id — they have no real container yet, so lifecycle would
  // 404 in the backend and contradict the GET. Reject with a clear 409 instead.
  // `destroy` is the exception: it dismisses a failed create (clears the queue
  // manifest), so let it fall through to the backend which handles `job:` ids.
  if (id.startsWith('job:') && action !== 'destroy') {
    return fail('conflict', `box ${id} is still being created; ${action} is not available yet`, {
      jobId: id.slice('job:'.length),
    });
  }
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  // `destroy` carries an optional `keepSnapshot` (mirrors the CLI's flag — a
  // docker box's snapshot dir is kept when true); every other action is body-less.
  if (action === 'destroy') {
    const parsed = await readJson(req);
    if (!parsed.ok) return fail('invalid_request', parsed.message);
    const keepSnapshot =
      typeof parsed.value === 'object' &&
      parsed.value !== null &&
      (parsed.value as { keepSnapshot?: unknown }).keepSnapshot === true;
    const res = await backend.destroy(id, { keepSnapshot });
    if (!res.ok) return failFromAction(res.error);
    return ok({ ok: true });
  }

  const res = await backend[action](id);
  if (!res.ok) return failFromAction(res.error);
  return ok({ ok: true });
}
