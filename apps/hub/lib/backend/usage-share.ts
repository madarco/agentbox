// Share the usage dashboard on agent-box.sh (docs/usage-dashboard-plan.md, Phase 6).
// The hub builds the public `UsageShare` with `toShare` and posts it to
// `share.endpoint` itself: the browser and the CLI only call
// `POST /api/v1/usage/share`. The first post for a handle returns a claim secret;
// it stays in `~/.agentbox/hub/share.json` (0600) and goes out only as the Bearer
// of later posts for that handle to the same site. It is never returned or logged.
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HANDLE_RE, toShare, type UsageShare, type UsageStats } from '@agentbox/usage-view';

export const DEFAULT_SHARE_ENDPOINT = 'https://agent-box.sh/api/share';
const POST_TIMEOUT_MS = 20_000;

export type ShareErrorCode =
  | 'invalid_request'
  | 'conflict'
  | 'rate_limited'
  | 'payload_too_large'
  | 'backend_unavailable'
  | 'upstream_error';

export class ShareError extends Error {
  constructor(
    readonly code: ShareErrorCode,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ShareError';
  }
}

/** The endpoint as a URL: https, or http only to this machine (a local `next dev`). */
export function parseShareEndpoint(raw: string | undefined): URL {
  const value = raw?.trim() || DEFAULT_SHARE_ENDPOINT;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ShareError('invalid_request', `share.endpoint is not a URL: ${value}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new ShareError(
      'invalid_request',
      `share.endpoint must be https (http only for localhost): ${value}`,
    );
  }
  if (url.username || url.password) {
    throw new ShareError('invalid_request', 'share.endpoint must not carry credentials');
  }
  return url;
}

export function checkHandle(raw: unknown): string {
  const handle = typeof raw === 'string' ? raw.trim() : '';
  if (!HANDLE_RE.test(handle)) {
    throw new ShareError(
      'invalid_request',
      'handle must be 1-39 characters of lowercase letters, digits and dashes',
    );
  }
  return handle;
}

// ── claim secrets ──

interface ClaimFile {
  version: 1;
  /** Keyed `<endpoint origin> <handle>`: a claim belongs to one site's database. */
  claims: Record<string, { secret: string; claimedAt: string }>;
  /** The handle of the last share, to fill the form with next time. */
  lastHandle?: string;
}

export interface ClaimStore {
  secret(origin: string, handle: string): Promise<string | null>;
  save(origin: string, handle: string, secret: string): Promise<void>;
  remember(handle: string): Promise<void>;
  /** Handles this hub holds a claim for on `origin`, and the last one shared. */
  known(origin: string): Promise<{ handles: string[]; lastHandle: string | null }>;
}

const claimKey = (origin: string, handle: string): string => `${origin} ${handle}`;

/** The claim secrets in one 0600 JSON file. Writes are serialized and atomic. */
export function fileClaimStore(path: string): ClaimStore {
  let chain: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<ClaimFile> => {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ClaimFile>;
      return {
        version: 1,
        claims: parsed.claims && typeof parsed.claims === 'object' ? parsed.claims : {},
        ...(typeof parsed.lastHandle === 'string' ? { lastHandle: parsed.lastHandle } : {}),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, claims: {} };
      // A corrupt file must not be overwritten: it may hold a secret worth recovering.
      throw new ShareError(
        'backend_unavailable',
        `${path} could not be read (${(e as Error).message}); fix or move it`,
      );
    }
  };
  const update = (fn: (f: ClaimFile) => void): Promise<void> => {
    const next = chain.then(async () => {
      const f = await read();
      fn(f);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${String(process.pid)}.tmp`;
      await writeFile(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, path);
    });
    chain = next.catch(() => undefined);
    return next;
  };
  return {
    async secret(origin, handle) {
      return (await read()).claims[claimKey(origin, handle)]?.secret ?? null;
    },
    save: (origin, handle, secret) =>
      update((f) => {
        f.claims[claimKey(origin, handle)] = { secret, claimedAt: new Date().toISOString() };
      }),
    remember: (handle) =>
      update((f) => {
        f.lastHandle = handle;
      }),
    async known(origin) {
      const f = await read();
      const prefix = `${origin} `;
      const handles = Object.keys(f.claims)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .sort();
      return { handles, lastHandle: f.lastHandle ?? null };
    },
  };
}

// ── posting ──

export interface UsageShareDeps {
  /** The stats of the window the request names (`usageStats` over the parsed query). */
  stats: () => Promise<UsageStats>;
  endpoint: () => Promise<string | undefined>;
  claims: ClaimStore;
  fetch?: typeof fetch;
}

export interface UsageSharePreview {
  share: UsageShare;
  endpoint: string;
  /** Bytes of the JSON body that will be posted. */
  bytes: number;
  /** True when this hub already holds the handle's claim on that site. */
  claimed: boolean;
}

export interface UsageSharePosted {
  url: string;
  handle: string;
  n: number;
  /** True when this post claimed the handle (its first share). */
  claimedNow: boolean;
}

/** What `POST /usage/share` with `preview: true` returns: the exact share, not posted. */
export async function previewUsageShare(
  deps: UsageShareDeps,
  handleRaw: unknown,
): Promise<UsageSharePreview> {
  const handle = checkHandle(handleRaw);
  const endpoint = parseShareEndpoint(await deps.endpoint());
  const share = toShare(await deps.stats(), handle);
  return {
    share,
    endpoint: endpoint.href,
    bytes: Buffer.byteLength(JSON.stringify(share)),
    claimed: (await deps.claims.secret(endpoint.origin, handle)) !== null,
  };
}

function retryAfterOf(res: Response): number | undefined {
  const n = Number(res.headers.get('retry-after'));
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
}

/** Builds the share, posts it to `share.endpoint`, keeps a new claim secret. */
export async function postUsageShare(
  deps: UsageShareDeps,
  handleRaw: unknown,
): Promise<UsageSharePosted> {
  const handle = checkHandle(handleRaw);
  const endpoint = parseShareEndpoint(await deps.endpoint());
  const share = toShare(await deps.stats(), handle);
  const secret = await deps.claims.secret(endpoint.origin, handle);
  const doFetch = deps.fetch ?? fetch;
  const site = endpoint.host;

  let res: Response;
  try {
    res = await doFetch(endpoint.href, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify(share),
      redirect: 'error',
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    throw new ShareError(
      'upstream_error',
      timedOut
        ? `${site} did not answer within ${String(POST_TIMEOUT_MS / 1000)}s`
        : `${site} could not be reached: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (res.status !== 201 && res.status !== 200) {
    // Read the site's error for logs only as a status; its text is not ours to forward.
    await res.body?.cancel().catch(() => undefined);
    switch (res.status) {
      case 400:
        throw new ShareError(
          'upstream_error',
          `${site} refused the share as invalid: its share schema may differ from this hub's (update agentbox, or check share.endpoint)`,
        );
      case 401:
      case 403:
      case 409:
        throw new ShareError(
          'conflict',
          secret
            ? `${site} refused the claim secret this hub holds for "${handle}"`
            : `the handle "${handle}" is already claimed on ${site}: pick another one`,
        );
      case 413:
        throw new ShareError('payload_too_large', `${site} refused the share as too large`);
      case 429: {
        const retryAfter = retryAfterOf(res);
        throw new ShareError(
          'rate_limited',
          `${site} allows only a few shares an hour from one address: try again${retryAfter ? ` in ${String(Math.ceil(retryAfter / 60))} min` : ' later'}`,
          retryAfter,
        );
      }
      case 503:
        throw new ShareError('backend_unavailable', `sharing is not configured on ${site}`);
      default:
        throw new ShareError('upstream_error', `${site} answered ${String(res.status)}`);
    }
  }

  let body: { url?: unknown; handle?: unknown; n?: unknown; claimSecret?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new ShareError('upstream_error', `${site} answered with something other than JSON`);
  }
  const url = typeof body.url === 'string' ? body.url : '';
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw new ShareError('upstream_error', `${site} did not return the share's URL`);
  }
  const n = typeof body.n === 'number' && Number.isSafeInteger(body.n) ? body.n : 0;
  const claimSecret = typeof body.claimSecret === 'string' ? body.claimSecret : '';
  // Keep the secret before anything else can fail: without it the handle is lost.
  if (claimSecret) await deps.claims.save(endpoint.origin, handle, claimSecret);
  await deps.claims.remember(handle).catch(() => undefined);
  return { url: parsed.href, handle, n, claimedNow: claimSecret !== '' };
}
