// POST /api/v1/history/chunks — ingest one raw transcript frame (session history,
// docs/agent-history-plan.md). Body: `{origin, agent, path, offset, sha256Prefix,
// sha256, data, reset?}` with `data` base64. Answers the ingest result:
// `{ok: true, offset, sha256}`, or `{ok: false, code, message, offset?, sha256?}`
// (200 either way: an `offset_mismatch` tells the shipper where to resume).
// The hub's own relay calls the same service in-process; this route is for a
// relay or shipper elsewhere. The caller holds a hub credential (admin or
// device token) and is trusted to name the origin box, like every other
// /api/v1 write; boxes themselves never reach this route. A host session
// (`origin.kind: "host"`, agent-history Phase 5) is a PC's own: a device-token
// caller's `hostId` is replaced with its verified device id.
import { parseHistoryFrame } from '@agentbox/core';
import { DEVICE_ID_HEADER } from '@/lib/peer';
import { fail, ok } from '../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_CHARS = 12 * 1024 * 1024;

function deviceOf(req: Request): string {
  return (req.headers.get(DEVICE_ID_HEADER) ?? '').trim();
}

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
  const frame = parseHistoryFrame(body);
  const host = frame?.origin.kind === 'host';
  if (!frame || (host ? !frame.origin.hostId && !deviceOf(req) : !frame.origin.boxId)) {
    return fail(
      'invalid_request',
      'expected {origin:{boxId} or {kind:"host", hostId}, agent, path (relative), offset, sha256Prefix, sha256, data}',
    );
  }
  // A PC on its own device token ships its own host sessions only: the PC is
  // the verified device, whatever the frame says.
  const device = deviceOf(req);
  if (host && device) frame.origin.hostId = device;
  const res = await history.ingest(frame);
  return ok(res);
}
