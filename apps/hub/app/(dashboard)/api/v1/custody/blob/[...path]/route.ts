// /api/v1/custody/blob/<scope>/<...> — the STREAMING custody surface.
//
//   PUT  raw application/octet-stream → metadata only ({changed,sha256,size,…})
//   GET  raw application/octet-stream → ELEVATED (same gate as the JSON route)
//
// Why a second endpoint instead of a content-type branch on `/api/v1/custody`:
// that route is the easy, general-purpose one — base64 in a JSON envelope, which
// any consumer can produce with a curl and a `base64`, and exactly right for what
// custody was built to hold (credentials, `.env`, SSH keys — kilobytes). It stays
// untouched. This one exists for the objects that break that assumption: a
// project's `carry:` material runs to `box.cpMaxBytes` (100 MiB), where the JSON
// envelope costs several times the payload in peak memory on a 4 GB control box.
//
// Because it is additive, there is no wire to break — a hub predating it simply
// 404s the prefix, which the client detects and reports precisely rather than
// silently dropping a file the user approved.
//
// The byte-read gate is IDENTICAL to the JSON route's and for the same reason:
// custody holds credentials and SSH private keys, and the `/api/v1` API key
// travels to the tray and thin clients, so reading bytes needs a second,
// non-distributed credential. Streaming changes the transport, never the trust.
import { Readable } from 'node:stream';
import { authMode } from '@/lib/auth-config';
import { custodyByteReadAuthorized } from '@/lib/custody-auth';
import { PEER_LOOPBACK_HEADER } from '@/lib/peer';
import { fail, ok } from '../../../lib/envelope';
import { normalizeCustodyPathSegments } from '../../../lib/custody-path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function custodyOrFail(): NonNullable<typeof globalThis.__AGENTBOX_HUB_CUSTODY> | Response {
  const custody = globalThis.__AGENTBOX_HUB_CUSTODY;
  if (!custody) return fail('backend_unavailable', 'custody is not enabled on this hub');
  return custody;
}

function byteReadAllowed(req: Request): boolean {
  return custodyByteReadAuthorized({
    mode: authMode(),
    adminToken: process.env.AGENTBOX_RELAY_ADMIN_TOKEN ?? '',
    providedToken: req.headers.get('x-agentbox-admin-token') ?? '',
    isLoopback: req.headers.get(PEER_LOOPBACK_HEADER) === '1',
  });
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const custody = custodyOrFail();
  if (custody instanceof Response) return custody;
  const norm = normalizeCustodyPathSegments((await ctx.params).path);
  if (!norm.ok) return fail('invalid_request', norm.message);
  if (!req.body) return fail('invalid_request', 'expected a request body');

  try {
    // `req.body` is the DOM ReadableStream; `Readable.fromWeb` wants node's web
    // stream type. Structurally the same object at runtime — the cast is the
    // standard bridge between the two type universes, not a soundness hole.
    const webBody = req.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>;
    const result = await custody.putStream(norm.path, Readable.fromWeb(webBody), {
      ...(globalThis.__AGENTBOX_HUB_CUSTODY_MAX_BLOB_BYTES !== undefined
        ? { maxBytes: globalThis.__AGENTBOX_HUB_CUSTODY_MAX_BLOB_BYTES }
        : {}),
    });
    return ok(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'custody put failed';
    // The store throws CustodyTooLargeError by name; matching on that rather than
    // importing it keeps @agentbox/relay out of Next's bundle (see global.d.ts).
    if (err instanceof Error && err.name === 'CustodyTooLargeError') {
      return fail(
        'invalid_request',
        `${msg}. Raise AGENTBOX_CUSTODY_MAX_BLOB_BYTES on this hub and \`relay.custodyMaxBlobBytes\` on the client.`,
      );
    }
    return fail('internal', msg);
  }
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const custody = custodyOrFail();
  if (custody instanceof Response) return custody;
  const norm = normalizeCustodyPathSegments((await ctx.params).path);
  if (!norm.ok) return fail('invalid_request', norm.message);
  if (!byteReadAllowed(req)) {
    return fail(
      'unauthorized',
      authMode() === 'password'
        ? 'reading a custody value requires the admin token (send X-Agentbox-Admin-Token); the hub API key can list and write but never read a stored value'
        : 'reading a custody value is loopback-only on a local hub (custody holds credentials and SSH private keys); read it from the hub machine itself, not over the network',
    );
  }
  try {
    const found = await custody.getStream(norm.path);
    if (!found) return fail('not_found', 'no such custody entry');
    return new Response(Readable.toWeb(Readable.from(found.data)) as ReadableStream, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(found.entry.size),
        'x-agentbox-sha256': found.entry.sha256,
      },
    });
  } catch (err) {
    return fail('internal', err instanceof Error ? err.message : 'custody get failed');
  }
}
