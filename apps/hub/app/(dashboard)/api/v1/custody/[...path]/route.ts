// /api/v1/custody/<scope>/<...> — the path-addressed custody verbs, the client
// surface for `agentbox hub credentials/secrets/custody/project` and the tray/web.
//
//   PUT     store bytes at a custody path          → metadata only ({changed,sha256,size,…})
//   DELETE  remove one custody entry               → 204 / 404
//   GET     read a stored blob's BYTES             → ELEVATED (see below)
//
// METADATA-ONLY CONTRACT. Custody holds agent credentials, `.env` files and per-box
// SSH PRIVATE KEYS. The `/api/v1` gate is the hub API key (proxy.ts), which on a
// control box travels to the tray / web / thin clients — so a byte-echoing route
// keyed on it alone would be a credential-disclosure bug. list/PUT/DELETE therefore
// return metadata only and are API-key-gated; the byte-read GET requires a SECOND,
// non-distributed credential:
//   - password profile (a real/exposed control box): the admin token
//     (`AGENTBOX_RELAY_ADMIN_TOKEN`), presented as `X-Agentbox-Admin-Token`. A
//     caller with only the hub API key is refused (401) — that refusal IS the
//     contract. The PC that ran `hub setup`/`expose` holds the admin token, so its
//     `credentials pull` / SSH-key adopt still round-trips.
//   - token profile (a plain local hub): the hub token already gated the request in
//     proxy.ts, and it is a machine-local secret (not distributed like the API key),
//     so it is itself the elevated credential — no second header needed.
//
// Reaches the store through globalThis (set by server.ts) so @agentbox/relay stays
// out of Next's bundle (a runtime import of FsCustodyStore ERR_MODULE_NOT_FOUNDs on
// execa in the standalone build — see global.d.ts).
import { authMode } from '@/lib/auth-config';
import { custodyByteReadAuthorized } from '@/lib/custody-auth';
import { fail, ok } from '../../lib/envelope';
import { readJson } from '../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A faithful copy of @agentbox/relay's normalizeCustodyPath (store.ts): validating
// here gives a clean 400 rather than forwarding a bad path to the store. Duplicated
// (not imported) for the bundle reason above; the store re-validates as the real
// enforcement, so a drift can only ever reject earlier, never let a bad path
// through. Keep in sync with store.ts if the scopes/segment rules change.
const CUSTODY_SCOPES = ['agents', 'projects', 'boxes', 'prepared'];
const AGENT_IDS = ['claude', 'codex', 'opencode'];
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const MAX_SEGMENTS = 6;
const MAX_PATH_LENGTH = 256;

function normalizeCustodyPath(
  segments: string[],
): { ok: true; path: string } | { ok: false; message: string } {
  const trimmed = segments.filter((s) => s.length > 0);
  const joined = trimmed.join('/');
  if (joined.length === 0) return { ok: false, message: 'empty custody path' };
  if (joined.length > MAX_PATH_LENGTH) {
    return { ok: false, message: `custody path too long (max ${String(MAX_PATH_LENGTH)} chars)` };
  }
  if (trimmed.length < 2) return { ok: false, message: 'custody path needs a scope and a name' };
  if (trimmed.length > MAX_SEGMENTS) {
    return { ok: false, message: `custody path too deep (max ${String(MAX_SEGMENTS)} segments)` };
  }
  for (const seg of trimmed) {
    if (seg === '.' || seg === '..' || !SEGMENT_RE.test(seg)) {
      return { ok: false, message: `illegal custody path segment: '${seg}'` };
    }
  }
  if (!CUSTODY_SCOPES.includes(trimmed[0]!)) {
    return {
      ok: false,
      message: `unknown custody scope '${trimmed[0]!}' (expected ${CUSTODY_SCOPES.join(' | ')})`,
    };
  }
  if (trimmed[0] === 'agents' && !AGENT_IDS.includes(trimmed[1]!)) {
    return {
      ok: false,
      message: `unknown agent '${trimmed[1]!}' (expected ${AGENT_IDS.join(' | ')})`,
    };
  }
  return { ok: true, path: joined };
}

/**
 * Whether this request may read a stored blob's bytes. The proxy has already gated
 * the API key/hub token; this layers the elevated admin-token check on top for byte
 * reads only. The decision is a pure, unit-tested helper (see custody-auth.ts) so
 * the fail-closed invariant survives a refactor of this route.
 */
function byteReadAllowed(req: Request): boolean {
  return custodyByteReadAuthorized({
    mode: authMode(),
    adminToken: process.env.AGENTBOX_RELAY_ADMIN_TOKEN ?? '',
    providedToken: req.headers.get('x-agentbox-admin-token') ?? '',
  });
}

function custodyOrFail(): NonNullable<typeof globalThis.__AGENTBOX_HUB_CUSTODY> | Response {
  const custody = globalThis.__AGENTBOX_HUB_CUSTODY;
  if (!custody) return fail('backend_unavailable', 'custody is not enabled on this hub');
  return custody;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const custody = custodyOrFail();
  if (custody instanceof Response) return custody;
  const norm = normalizeCustodyPath((await ctx.params).path);
  if (!norm.ok) return fail('invalid_request', norm.message);
  if (!byteReadAllowed(_req)) {
    return fail(
      'unauthorized',
      'reading a custody value requires the admin token (send X-Agentbox-Admin-Token); the hub API key can list and write but never read a stored value',
    );
  }
  try {
    const found = await custody.get(norm.path);
    if (!found) return fail('not_found', 'no such custody entry');
    return ok({ ...found.entry, data: found.data.toString('base64') });
  } catch (err) {
    return fail('internal', err instanceof Error ? err.message : 'custody get failed');
  }
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const custody = custodyOrFail();
  if (custody instanceof Response) return custody;
  const norm = normalizeCustodyPath((await ctx.params).path);
  if (!norm.ok) return fail('invalid_request', norm.message);

  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  const data = (body.value as { data?: unknown }).data;
  if (typeof data !== 'string') return fail('invalid_request', 'expected { data: <base64> }');
  const buf = Buffer.from(data, 'base64');
  // base64 decoding is lenient (it drops junk rather than throwing), so round-trip
  // it: a value that doesn't re-encode identically was not base64 and would be
  // stored silently truncated.
  if (buf.toString('base64') !== data.replace(/\s+/g, '')) {
    return fail('invalid_request', 'data is not valid base64');
  }
  try {
    const result = await custody.put(norm.path, buf);
    // Metadata only — never the stored bytes.
    return ok(result);
  } catch (err) {
    return fail('internal', err instanceof Error ? err.message : 'custody put failed');
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const custody = custodyOrFail();
  if (custody instanceof Response) return custody;
  const norm = normalizeCustodyPath((await ctx.params).path);
  if (!norm.ok) return fail('invalid_request', norm.message);
  try {
    const hit = await custody.delete(norm.path);
    if (!hit) return fail('not_found', 'no such custody entry');
    return new Response(null, { status: 204 });
  } catch (err) {
    return fail('internal', err instanceof Error ? err.message : 'custody delete failed');
  }
}
