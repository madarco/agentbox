// POST /api/v1/history/chunks — ingest one raw transcript frame (session history,
// docs/agent-history-plan.md). Body: `{origin, agent, path, offset, sha256Prefix,
// sha256, data, reset?}` with `data` base64. Answers the ingest result:
// `{ok: true, offset, sha256}`, or `{ok: false, code, message, offset?, sha256?}`
// (200 either way: an `offset_mismatch` tells the shipper where to resume).
// The hub's own relay calls the same service in-process; this route is for a
// relay or shipper elsewhere.
import { fail, ok } from '../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_CHARS = 12 * 1024 * 1024;

export async function POST(req: Request): Promise<Response> {
  const history = globalThis.__AGENTBOX_HUB_HISTORY;
  if (!history) return fail('backend_unavailable', 'session history is not enabled on this hub');
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return fail('invalid_request', 'frame too large');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail('invalid_request', 'body is not JSON');
  }
  const b = body as Record<string, unknown> | null;
  const origin = b && typeof b.origin === 'object' ? (b.origin as Record<string, unknown>) : null;
  if (
    !b ||
    !origin ||
    typeof origin.boxId !== 'string' ||
    typeof b.agent !== 'string' ||
    typeof b.path !== 'string' ||
    typeof b.offset !== 'number' ||
    !Number.isSafeInteger(b.offset) ||
    b.offset < 0 ||
    typeof b.sha256Prefix !== 'string' ||
    typeof b.sha256 !== 'string' ||
    typeof b.data !== 'string'
  ) {
    return fail(
      'invalid_request',
      'expected {origin:{boxId}, agent, path, offset, sha256Prefix, sha256, data}',
    );
  }
  if (b.path.startsWith('/') || b.path.split('/').some((s) => s === '..' || s === '')) {
    return fail('invalid_request', 'path must be relative with no empty or .. segments');
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const res = await history.ingest({
    origin: {
      boxId: origin.boxId,
      ...(str(origin.boxName) ? { boxName: str(origin.boxName) } : {}),
      ...(str(origin.provider) ? { provider: str(origin.provider) } : {}),
      ...(str(origin.hostId) ? { hostId: str(origin.hostId) } : {}),
      ...(str(origin.projectRepoUrl) ? { projectRepoUrl: str(origin.projectRepoUrl) } : {}),
    },
    agent: b.agent,
    path: b.path,
    offset: b.offset,
    sha256Prefix: b.sha256Prefix,
    sha256: b.sha256,
    data: b.data,
    ...(b.reset === true ? { reset: true } : {}),
  });
  return ok(res);
}
