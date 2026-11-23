// GET|PUT /api/v1/history/host — this hub machine's host-session watcher
// (agent-history Phase 5): whether it is on, every known project folder with
// its own allow/deny and the outcome, and the watcher's last pass.
// PUT body: `{enabled?: boolean, project?: {folder, mode: allow|deny|inherit}}`;
// answers the updated view. The watcher picks a change up on its next pass.
import { createHostSessionsBackend, parseHostSessionsPatch } from '@/lib/backend/history-host';
import { fail, ok } from '../../lib/envelope';
import { readJson } from '../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return ok(await createHostSessionsBackend().view());
}

export async function PUT(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  const patch = parseHostSessionsPatch(body.value);
  if (!patch.ok) return fail('invalid_request', patch.message);
  try {
    return ok(await createHostSessionsBackend().update(patch.value));
  } catch (e) {
    return fail('invalid_request', e instanceof Error ? e.message : String(e));
  }
}
