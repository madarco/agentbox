/**
 * The `/remote/boxes` create-queue surface, as a framework-agnostic dispatcher
 * mounted by BOTH relay front-ends: the hosted-plane handler (`core/handler.ts`,
 * Next/Vercel) and the relay daemon (`server.ts`, node:http — what the control
 * box actually runs). One implementation, one gate, both profiles.
 *
 * Like custody, the **admin bearer is the only proof** — never loopback (the
 * control box sits behind Caddy on the same host, so every proxied request looks
 * loopback). Missing admin token → 503 (not configured); wrong token → 401; a
 * store without the create-job queue → 501.
 */

import { randomUUID } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import type { CustodyStore } from './custody/store.js';
import type { CreateJobRequest, Store } from './store/store.js';

/** Structurally identical to `RelayResponse` in `core/handler.ts` (kept local to avoid a cycle). */
export interface RemoteBoxesResponse {
  status: number;
  body?: unknown;
}

export interface RemoteBoxesRequest {
  method: string;
  /** URL pathname, e.g. `/remote/boxes` or `/remote/boxes/<jobId>`. */
  path: string;
  /** Bearer token as presented ('' when absent). */
  bearer: string;
  /** Raw request body ('' for GET). */
  bodyText: string;
}

export interface RemoteBoxesDeps {
  store: Store;
  /** Admin bearer. Empty/absent → not configured (503). */
  adminToken?: string;
  /**
   * Providers this plane can CREATE boxes on. `undefined`/empty → all allowed
   * (the full-host control box). A serverless plane sets the SDK-native set.
   */
  createProviders?: string[];
  /**
   * The custody store, if wired. A reap (`DELETE`) also removes the box's
   * `boxes/<sandboxId>/` SSH-key subtree from here so a destroyed box leaves no
   * key material behind. Absent → the reap only clears the registration/status.
   */
  custody?: CustodyStore | null;
  log?: (line: string) => void;
}

export const REMOTE_BOXES_PREFIX = '/remote/boxes';

/** True when `path` addresses the create-queue surface. */
export function isRemoteBoxesPath(path: string): boolean {
  return path === REMOTE_BOXES_PREFIX || path.startsWith(`${REMOTE_BOXES_PREFIX}/`);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function parseJson<T>(text: string): T | null {
  if (text.length === 0) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Dispatch one `/remote/boxes` request. Returns `null` when `req.path` is not a
 * create-queue path, so a host router falls through to its own routes unchanged.
 */
export async function handleRemoteBoxesRequest(
  req: RemoteBoxesRequest,
  deps: RemoteBoxesDeps,
): Promise<RemoteBoxesResponse | null> {
  if (!isRemoteBoxesPath(req.path)) return null;
  const log = deps.log ?? (() => {});
  const { store } = deps;

  const adminToken = deps.adminToken ?? '';
  if (adminToken.length === 0) {
    return { status: 503, body: { error: 'control plane not configured: admin token unset' } };
  }
  if (!timingSafeEqualStr(req.bearer, adminToken)) {
    return { status: 401, body: { error: 'invalid admin token' } };
  }

  if (req.method === 'POST' && req.path === REMOTE_BOXES_PREFIX) {
    if (!store.enqueueCreateJob) {
      return { status: 501, body: { error: 'create-job queue not available on this store' } };
    }
    const body = parseJson<CreateJobRequest>(req.bodyText);
    if (!body || typeof body.repoUrl !== 'string' || typeof body.provider !== 'string') {
      return { status: 400, body: { error: 'expected {repoUrl, provider, branch?, name?, agent?, prompt?}' } };
    }
    const allowed = deps.createProviders;
    if (allowed && allowed.length > 0 && !allowed.includes(body.provider)) {
      return {
        status: 400,
        body: {
          error: `provider '${body.provider}' is not supported by this control plane (allowed: ${allowed.join(', ')})`,
        },
      };
    }
    const id = randomUUID();
    await store.enqueueCreateJob({
      id,
      status: 'queued',
      request: {
        repoUrl: body.repoUrl,
        provider: body.provider,
        branch: body.branch,
        name: body.name,
        agent: body.agent,
        prompt: body.prompt,
      },
      createdAt: new Date().toISOString(),
    });
    log(`enqueued create job ${id} (${body.provider} ${body.repoUrl})`);
    return { status: 202, body: { jobId: id } };
  }

  if (req.method === 'GET' && req.path.startsWith(`${REMOTE_BOXES_PREFIX}/`)) {
    if (!store.getCreateJob) {
      return { status: 501, body: { error: 'create-job queue not available on this store' } };
    }
    const id = decodeURIComponent(req.path.slice(`${REMOTE_BOXES_PREFIX}/`.length));
    const job = await store.getCreateJob(id);
    return job ? { status: 200, body: job } : { status: 404, body: { error: 'no such job' } };
  }

  // Reap a control-plane box's state from the control box: registration + status
  // + its SSH-key custody subtree. NOT the cloud resource — that teardown needs
  // provider creds + a reconstructed BoxRecord (the hub backend does it when it
  // can). The PC drives this via `hub boxes rm`; the hub UI's Destroy
  // button reaps a Store-registered box the same way.
  if (req.method === 'DELETE' && req.path.startsWith(`${REMOTE_BOXES_PREFIX}/`)) {
    const boxId = decodeURIComponent(req.path.slice(`${REMOTE_BOXES_PREFIX}/`.length));
    if (boxId.length === 0) return { status: 404, body: { error: 'no such box' } };
    const reg = await store.getBox(boxId);
    const existed = await store.forgetBox(boxId);
    await store.deleteStatus(boxId);
    let custodyRemoved = 0;
    if (deps.custody) {
      // Keyed by sandboxId on disk + in custody; fall back to boxId for
      // registrations minted before sandboxId was carried.
      const key = reg?.sandboxId ?? boxId;
      const entries = await deps.custody.list(`boxes/${key}`).catch(() => []);
      for (const e of entries) {
        if (await deps.custody.delete(e.path).catch(() => false)) custodyRemoved += 1;
      }
    }
    if (!existed && !reg && custodyRemoved === 0) {
      return { status: 404, body: { error: 'no such box' } };
    }
    log(`reaped box ${boxId} (registration=${String(existed)}, custody=${String(custodyRemoved)})`);
    return { status: 200, body: { boxId, removed: existed, custodyRemoved } };
  }

  return { status: 405, body: { error: 'method not allowed' } };
}
