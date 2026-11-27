// Share the usage dashboard on agent-box.sh (docs/usage-dashboard-plan.md, Phase 6).
// The hub builds the public `UsageShare` with `toShare` and posts it to
// `share.endpoint` itself: the browser and the CLI only call `/api/v1/usage/share`.
// The site answers with the share's random id and a delete secret. The secret stays
// in `~/.agentbox/hub/share.json` (0600) and goes out only to delete that one share
// on the site that minted it. It is never returned or logged.
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  SHARE_NAME_RE,
  parseShareBody,
  toShare,
  type UsageShare,
  type UsageStats,
} from '@agentbox/usage-view';

export const DEFAULT_SHARE_ENDPOINT = 'https://agent-box.sh/api/share';
const POST_TIMEOUT_MS = 20_000;
/** What the site mints: lowercase letters and digits, long enough to be unguessable. */
const SHARE_ID_RE = /^[a-z0-9]{20,64}$/;
/** The share API's 404 body error (`apps/web/lib/share/post.ts`). */
const SITE_NOT_FOUND = 'no such share';

export type ShareErrorCode =
  | 'invalid_request'
  | 'not_found'
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

/** The optional display name: absent when empty, else the share schema's character rule. */
export function checkName(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const name = typeof raw === 'string' ? raw.trim() : null;
  if (name === '') return undefined;
  if (name === null || !SHARE_NAME_RE.test(name)) {
    throw new ShareError(
      'invalid_request',
      'name must be 1-39 characters of lowercase letters, digits and dashes',
    );
  }
  return name;
}

// ── the shares this hub made ──

export interface ShareRecord {
  /** The endpoint the share was posted to; its delete goes to `<endpoint>/<id>`. */
  endpoint: string;
  /** `endpoint`'s origin, which `url` is on. */
  origin: string;
  id: string;
  /** The public page; empty when the site answered without a usable one. */
  url: string;
  deleteSecret: string;
  createdAt: string;
}

/** A share as `GET /usage/share` lists it: never the secret. */
export type ShareListing = Omit<ShareRecord, 'deleteSecret'>;

interface ShareFile {
  version: 2;
  shares: ShareRecord[];
  /** The display name of the last share, to fill the form with next time. */
  lastName?: string;
}

export interface ShareStore {
  list(): Promise<ShareRecord[]>;
  add(record: ShareRecord): Promise<void>;
  remove(id: string): Promise<void>;
  rememberName(name: string | undefined): Promise<void>;
  lastName(): Promise<string | null>;
  /**
   * Last resort when `add` failed after the site stored a share: write the record
   * to a file of its own (0600) and return its path, or null.
   */
  salvage?(record: ShareRecord): Promise<string | null>;
}

const isRecord = (v: unknown): v is ShareRecord => {
  const r = v as Partial<ShareRecord> | null;
  return (
    !!r &&
    typeof r.endpoint === 'string' &&
    typeof r.origin === 'string' &&
    typeof r.id === 'string' &&
    typeof r.url === 'string' &&
    typeof r.deleteSecret === 'string' &&
    typeof r.createdAt === 'string'
  );
};

/** The share records in one 0600 JSON file. Writes are serialized and atomic. */
export function fileShareStore(path: string): ShareStore {
  let chain: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<ShareFile> => {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ShareFile>;
      return {
        version: 2,
        shares: Array.isArray(parsed.shares) ? parsed.shares.filter(isRecord) : [],
        ...(typeof parsed.lastName === 'string' ? { lastName: parsed.lastName } : {}),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, shares: [] };
      // A corrupt file must not be overwritten: it may hold delete secrets worth recovering.
      // No parse message: JSON.parse quotes the file, which may be part of a secret.
      const code = (e as NodeJS.ErrnoException).code;
      throw new ShareError(
        'backend_unavailable',
        `${path} could not be read${code ? ` (${code})` : ' (not valid JSON)'}; fix or move it`,
      );
    }
  };
  const update = (fn: (f: ShareFile) => void): Promise<void> => {
    const next = chain.then(async () => {
      const f = await read();
      fn(f);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        await writeFile(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, path);
      } catch (e) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw e;
      }
    });
    chain = next.catch(() => undefined);
    return next;
  };
  return {
    async list() {
      return (await read()).shares;
    },
    add: (record) =>
      update((f) => {
        f.shares = [...f.shares.filter((s) => s.id !== record.id), record];
      }),
    remove: (id) =>
      update((f) => {
        f.shares = f.shares.filter((s) => s.id !== id);
      }),
    rememberName: (name) =>
      update((f) => {
        if (name) f.lastName = name;
        else delete f.lastName;
      }),
    async lastName() {
      return (await read()).lastName ?? null;
    },
    async salvage(record) {
      const file = `${path}.share-${record.id}.json`;
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        return file;
      } catch {
        return null;
      }
    },
  };
}

/** The hub's shares, newest first, without their secrets. */
export async function listUsageShares(store: ShareStore): Promise<ShareListing[]> {
  return (await store.list())
    .map(
      (r): ShareListing => ({
        endpoint: r.endpoint,
        origin: r.origin,
        id: r.id,
        url: r.url,
        createdAt: r.createdAt,
      }),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ── posting ──

export interface UsageShareDeps {
  /** The stats of the window the request names (`usageStats` over the parsed query). */
  stats: () => Promise<UsageStats>;
  endpoint: () => Promise<string | undefined>;
  store: ShareStore;
  fetch?: typeof fetch;
}

export interface UsageSharePreview {
  share: UsageShare;
  endpoint: string;
  /** Bytes of the JSON body that will be posted. */
  bytes: number;
}

export interface UsageSharePosted {
  url: string;
  id: string;
  createdAt: string;
}

/** What `POST /usage/share` with `preview: true` returns: the exact share, not posted. */
export async function previewUsageShare(
  deps: UsageShareDeps,
  nameRaw: unknown,
): Promise<UsageSharePreview> {
  const name = checkName(nameRaw);
  const endpoint = parseShareEndpoint(await deps.endpoint());
  const share = toShare(await deps.stats(), name);
  return {
    share,
    endpoint: endpoint.href,
    bytes: Buffer.byteLength(JSON.stringify(share)),
  };
}

function retryAfterOf(res: Response): number | undefined {
  const n = Number(res.headers.get('retry-after'));
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
}

function failedStatus(res: Response, site: string, verb: 'share' | 'delete'): never {
  if (verb === 'delete' && (res.status === 400 || res.status === 413)) {
    throw new ShareError(
      'upstream_error',
      `${site} answered ${String(res.status)} to the delete; the share is kept here`,
    );
  }
  switch (res.status) {
    case 400:
      throw new ShareError(
        'upstream_error',
        `${site} refused the share as invalid: its share schema may differ from this hub's (update agentbox, or check share.endpoint)`,
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
      throw new ShareError(
        'upstream_error',
        `${site} answered ${String(res.status)} to the ${verb}`,
      );
  }
}

/**
 * A share the caller already holds (the dialog's preview, name included), checked
 * as the site checks it: the share schema admits only numbers, dates, enum ids and
 * the display name, so nothing else can ride along.
 */
function previewedShare(raw: unknown): { share: UsageShare; text: string } {
  let text: string;
  try {
    text = JSON.stringify(raw);
  } catch {
    throw new ShareError('invalid_request', 'share must be JSON');
  }
  try {
    // The strict schema refuses an unknown key, so the text holds nothing the parse dropped.
    return { share: parseShareBody(text), text };
  } catch (e) {
    throw new ShareError(
      'invalid_request',
      `share is not a valid usage share: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`,
    );
  }
}

/**
 * Posts the share to `share.endpoint` and keeps its delete secret. With `previewed`
 * (the share the dialog showed, name included) that exact share is sent, so the
 * JSON the user inspected is the JSON posted; without it the hub builds one.
 */
export async function postUsageShare(
  deps: UsageShareDeps,
  nameRaw: unknown,
  previewed?: unknown,
): Promise<UsageSharePosted> {
  const given = previewed === undefined ? undefined : previewedShare(previewed);
  const name = checkName(given ? given.share.name : nameRaw);
  const endpoint = parseShareEndpoint(await deps.endpoint());
  const payload = given ? given.text : JSON.stringify(toShare(await deps.stats(), name));
  // A store that can't be read can't keep the delete secret: fail before publishing.
  await deps.store.list();
  const doFetch = deps.fetch ?? fetch;
  const site = endpoint.host;

  let res: Response;
  try {
    res = await doFetch(endpoint.href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      redirect: 'error',
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    // A post has no idempotency key: the site may have stored the share before the
    // answer was lost, and then its id and delete secret never reached the hub.
    const maybe =
      'the share may have been published anyway, at a link this hub never learned and cannot delete';
    throw new ShareError(
      'upstream_error',
      timedOut
        ? `${site} did not answer within ${String(POST_TIMEOUT_MS / 1000)}s; ${maybe}`
        : `${site} could not be reached (${e instanceof Error ? e.message : String(e)}); ${maybe}`,
    );
  }

  if (res.status !== 201 && res.status !== 200) {
    // The site's error text is not ours to forward.
    await res.body?.cancel().catch(() => undefined);
    failedStatus(res, site, 'share');
  }

  let body: { url?: unknown; id?: unknown; deleteSecret?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new ShareError('upstream_error', `${site} answered with something other than JSON`);
  }
  const id = typeof body.id === 'string' && SHARE_ID_RE.test(body.id) ? body.id : '';
  const deleteSecret = typeof body.deleteSecret === 'string' ? body.deleteSecret : '';
  let where: string | null = null;
  try {
    const parsed = new URL(typeof body.url === 'string' ? body.url : '');
    if (parsed.origin === endpoint.origin) where = parsed.href;
  } catch {
    where = null;
  }
  if (!id || !deleteSecret) {
    throw new ShareError(
      'upstream_error',
      `${site} did not return a share id and delete secret${where ? ` (it answered ${where})` : ''}`,
    );
  }
  const record: ShareRecord = {
    endpoint: endpoint.href,
    origin: endpoint.origin,
    id,
    url: where ?? '',
    deleteSecret,
    createdAt: new Date().toISOString(),
  };
  // Keep the secret before anything else can fail: without it the share can't be deleted.
  try {
    await deps.store.add(record);
  } catch (e) {
    const kept = await deps.store.salvage?.(record);
    throw new ShareError(
      'backend_unavailable',
      `${where ? `shared at ${where}` : `${site} stored the share`}, but its delete secret could not be saved (${e instanceof Error ? e.message : String(e)})${kept ? `; it was written to ${kept}` : '; the share cannot be deleted from this hub'}`,
    );
  }
  if (!where) {
    throw new ShareError(
      'upstream_error',
      `${site} did not return a share URL on ${site} (share ${id} is kept, and can be deleted)`,
    );
  }
  await deps.store.rememberName(name).catch(() => undefined);
  return { url: where, id, createdAt: record.createdAt };
}

// ── deleting ──

export interface UsageShareDeleteDeps {
  store: ShareStore;
  fetch?: typeof fetch;
}

/**
 * Deletes one of this hub's shares on the site that holds it, then forgets it.
 * A share the site no longer has (404) is forgotten too. Returns whether the site
 * still had it.
 */
export async function deleteUsageShare(
  deps: UsageShareDeleteDeps,
  idRaw: string,
): Promise<{ id: string; deleted: boolean }> {
  const id = idRaw.trim();
  const record = SHARE_ID_RE.test(id) ? (await deps.store.list()).find((s) => s.id === id) : null;
  if (!record) throw new ShareError('not_found', `this hub made no share ${id}`);
  const endpoint = parseShareEndpoint(record.endpoint);
  const site = endpoint.host;
  const base = new URL(endpoint.href);
  base.search = '';
  base.hash = '';
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/${encodeURIComponent(id)}`;
  const target = base.href;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(target, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${record.deleteSecret}` },
      redirect: 'error',
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    throw new ShareError(
      'upstream_error',
      `${site} ${timedOut ? `did not answer within ${String(POST_TIMEOUT_MS / 1000)}s` : `could not be reached (${e instanceof Error ? e.message : String(e)})`}; the share is kept here, try again`,
    );
  }
  // Only the share API's own 404 means the share is gone. Any other 404 (a site build
  // without the DELETE route, a moved path) must not cost the only delete secret.
  let gone = false;
  if (res.status === 404) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    gone = body?.error === SITE_NOT_FOUND;
    if (!gone) {
      throw new ShareError(
        'upstream_error',
        `${site} has no share delete route at ${target}; the share is kept here`,
      );
    }
  } else {
    await res.body?.cancel().catch(() => undefined);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ShareError(
      'conflict',
      `${site} refused this hub's delete secret for share ${id}; it is kept here`,
    );
  }
  if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
    failedStatus(res, site, 'delete');
  }
  await deps.store.remove(id);
  return { id, deleted: !gone };
}
