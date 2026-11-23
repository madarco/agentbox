// GET|PUT /api/v1/history/host — this hub machine's host-session watcher
// (agent-history Phase 5): whether it is on, every known project folder with
// its own allow/deny and the outcome, and the watcher's last pass.
// PUT body: `{enabled?: boolean, project?: {folder, mode: allow|deny|inherit}}`;
// answers the updated view. The watcher picks a change up on its next pass.
import { parseHostSessionsPatch } from '@/lib/backend/history-host-patch';
import { DEVICE_ID_HEADER } from '@/lib/peer';
import { backendOrNull } from '../../lib/backend';
import { fail, ok } from '../../lib/envelope';
import { readJson } from '../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unavailable(): Response {
  return fail('backend_unavailable', 'host sessions need the in-process hub backend');
}

export async function GET(): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return unavailable();
  return ok(await backend.hostSessionsView());
}

export async function PUT(req: Request): Promise<Response> {
  // The setting decides what this machine's transcripts the hub ingests, and
  // writing a project key registers the folder: the owner's call, not an
  // enrolled PC's.
  if ((req.headers.get(DEVICE_ID_HEADER) ?? '').trim()) {
    return fail('forbidden', "only the hub owner can change this machine's host sessions");
  }
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  const patch = parseHostSessionsPatch(body.value);
  if (!patch.ok) return fail('invalid_request', patch.message);
  const backend = backendOrNull();
  if (!backend) return unavailable();
  try {
    return ok(await backend.updateHostSessions(patch.value));
  } catch (e) {
    return fail('invalid_request', e instanceof Error ? e.message : String(e));
  }
}
