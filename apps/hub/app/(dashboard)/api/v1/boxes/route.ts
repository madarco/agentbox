// GET  /api/v1/boxes  — list boxes (topology-agnostic read), or resolve one by
//                       `?ref=` (server-side box-ref resolution).
// POST /api/v1/boxes  — create a box (async; enqueues a build job, returns jobId).
import { resolveBoxRefView } from '@/lib/boxes/resolve';
import { backendOrNull, readState } from '../lib/backend';
import { fail, failFromAction, ok } from '../lib/envelope';
import { AGENTS, parseCreateBox, readJson } from '../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;

  // `?ref=<id|name|index>` — resolve a box ref server-side, mirroring the CLI's
  // local `findBox` (+ numeric project index when `?project=` is given). Returns
  // the match SET (`{ boxes }` with 0/1/many entries) so an ambiguous prefix is
  // expressed rather than arbitrarily narrowed. Resolution needs no live probe —
  // it matches on identity, not runtime state.
  const ref = params.get('ref');
  if (ref !== null) {
    const project = params.get('project') ?? undefined;
    const { boxes } = await readState();
    return ok({ boxes: resolveBoxRefView(boxes, ref, project) });
  }

  // `?live=1` (opt-in, expensive — mirrors GET /api/v1/providers?freshness=1):
  // refresh each cloud box's `state` with an authoritative provider SDK probe
  // instead of the fast persisted `cloud.lastState`. Only the in-process host
  // backend can probe; the read-only Postgres/plane path silently ignores it.
  const live = params.get('live') === '1';
  const { boxes } = await readState({ live });
  return ok({ boxes });
}

export async function POST(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  // Accept whatever the registry actually knows (plugin agents included) rather
  // than the compiled-in list — GET /api/v1/agents offers them, so refusing them
  // here would advertise a choice the create path rejects. Falls back to the
  // built-ins when the seam is absent (the plane path has no registry).
  const sys = globalThis.__AGENTBOX_HUB_SYSTEM;
  const allowedAgents = sys ? [...sys.agents().map((a) => a.id), 'none'] : AGENTS;
  const parsed = parseCreateBox(parsedBody.value, allowedAgents);
  if (!parsed.ok) return fail('invalid_request', parsed.message, parsed.details);

  const res = await backend.create(parsed.value);
  if (!res.ok) return failFromAction(res.error);
  return ok({ jobId: res.jobId }, 202);
}
