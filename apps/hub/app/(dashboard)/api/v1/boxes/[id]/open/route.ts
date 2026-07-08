// POST /api/v1/boxes/:id/open — launch the box in a host app (Codex, VS Code,
// cmux, Herdr, iTerm2) by re-shelling the installed `agentbox open --in <app>`.
// Host-GUI only: works on a localhost hub on macOS; the backend refuses otherwise
// (and the Postgres/plane path 503s, like the other mutating routes).
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';
import { parseOpenIn, readJson } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  // In-flight create jobs surface as synthetic `job:` boxes with no real
  // container yet — reject with a clear 409 instead of a backend error.
  if (id.startsWith('job:')) {
    return fail('conflict', `box ${id} is still being created; open-in is not available yet`, {
      jobId: id.slice('job:'.length),
    });
  }
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const p = parseOpenIn(parsedBody.value);
  if (!p.ok) return fail('invalid_request', p.message, p.details);

  const res = await backend.openIn(id, p.value.app);
  if (!res.ok) return failFromAction(res.error);
  return ok({ ok: true });
}
