// GET  /api/v1/boxes  — list boxes (topology-agnostic read).
// POST /api/v1/boxes  — create a box (async; enqueues a build job, returns jobId).
import { backendOrNull, readState } from '../lib/backend';
import { fail, failFromAction, ok } from '../lib/envelope';
import { parseCreateBox, readJson } from '../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  // `?live=1` (opt-in, expensive — mirrors GET /api/v1/providers?freshness=1):
  // refresh each cloud box's `state` with an authoritative provider SDK probe
  // instead of the fast persisted `cloud.lastState`. Only the in-process host
  // backend can probe; the read-only Postgres/plane path silently ignores it.
  const live = new URL(req.url).searchParams.get('live') === '1';
  const { boxes } = await readState({ live });
  return ok({ boxes });
}

export async function POST(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const parsed = parseCreateBox(parsedBody.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message, parsed.details);

  const res = await backend.create(parsed.value);
  if (!res.ok) return failFromAction(res.error);
  return ok({ jobId: res.jobId }, 202);
}
