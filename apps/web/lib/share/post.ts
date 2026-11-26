import { SHARE_MAX_BYTES, parseShareBody } from '@agentbox/usage-view';
import type { UsageShare } from '@agentbox/usage-view';
import { createShare, hashIp } from './store';
import type { Sql } from './store';

export interface SharePostDeps {
  sql: Sql | null;
  ipSalt: string | undefined;
  /** Called after a share is stored (the route revalidates its pages). */
  onStored?: (handle: string, n: number) => void;
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

/** The body as text, or null once it grows past `max` bytes (never buffered beyond that). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

/** The client IP as Vercel reports it. */
export function clientIp(req: Request): string {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return fwd || 'unknown';
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  return m ? m[1]! : null;
}

export async function handleSharePost(req: Request, deps: SharePostDeps): Promise<Response> {
  if (!deps.sql || !deps.ipSalt) return json({ error: 'sharing is not configured' }, 503);

  let raw: string | null;
  try {
    raw = await readCapped(req, SHARE_MAX_BYTES);
  } catch {
    return json({ error: 'body is not valid UTF-8' }, 400);
  }
  if (raw === null) return json({ error: `body over ${SHARE_MAX_BYTES} bytes` }, 413);

  let share: UsageShare;
  try {
    share = parseShareBody(raw);
  } catch {
    // No detail: the schema is public in @agentbox/usage-view, the hub builds valid shares.
    return json({ error: 'not a valid usage share' }, 400);
  }

  const result = await createShare(deps.sql, {
    share,
    ipHash: hashIp(clientIp(req), deps.ipSalt),
    secret: bearer(req),
  });
  if (!result.ok) {
    if (result.status === 429) {
      return json({ error: 'too many shares, try later' }, 429, {
        'Retry-After': String(result.retryAfter),
      });
    }
    return json({ error: 'this handle is claimed: send its claim secret' }, 403);
  }

  deps.onStored?.(share.handle, result.n);
  const url = `${new URL(req.url).origin}/u/${share.handle}/${result.n}`;
  return json(
    {
      url,
      handle: share.handle,
      n: result.n,
      ...(result.claimSecret ? { claimSecret: result.claimSecret } : {}),
    },
    201,
  );
}
