// POST /api/v1/boxes/:id/backup — capture the box into
// `<project>/.agentbox/bots/<bot>/<stamp>/` on the HUB's machine: the workspace
// half, plus the agent's whole state dir (identity included) when its registry row
// declares one. The mirror of `agentbox download --backup`, and what a later
// `POST /projects/:id/restore` reads back.
//
// Synchronous, like `checkpoint` and `clone`: a bot's workspace is small, and the
// job queue has only `create`/`prepare` lanes. Needs the in-process host backend
// (it drives provider.exec and writes the hub's own disk); the Postgres/plane path 503s.
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';
import { parseBoxBackup, readJson } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (id.startsWith('job:')) {
    return fail('conflict', `box ${id} is still being created; backup is not available yet`);
  }
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const raw = await readJson(req);
  if (!raw.ok) return fail('invalid_request', raw.message);
  const parsed = parseBoxBackup(raw.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message, parsed.details);

  const res = await backend.backupBox(id, parsed.value);
  if (!res.ok) return failFromAction(res.error);
  return ok(res);
}
