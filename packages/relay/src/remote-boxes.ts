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
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
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
  /** Query params, for the log tail's `?offset=`. Absent → treated as empty. */
  query?: URLSearchParams;
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
  /**
   * Tail of a job's progress log, by byte offset. Wired by the relay daemon
   * (which runs on the same host as the worker writing the file) and omitted by
   * the serverless plane, where there is no such file — absent → 501, and a
   * polling client falls back to status-only progress.
   */
  readJobLog?: (jobId: string, offset: number) => Promise<{ lines: string[]; offset: number }>;
  log?: (line: string) => void;
}

export const REMOTE_BOXES_PREFIX = '/remote/boxes';

/**
 * A job id we are willing to hand to a path-building reader.
 *
 * Enforced HERE, at the trust boundary, not only inside the one reader that
 * builds a path today: `readJobLog` is injectable, and a future implementation
 * that forgot the check would inherit a path traversal straight off the URL.
 */
export function isSafeJobId(id: string): boolean {
  return id.length > 0 && id.length <= 128 && /^[A-Za-z0-9._-]+$/.test(id);
}

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
      return {
        status: 400,
        body: { error: 'expected {repoUrl, provider, branch?, name?, agent?, prompt?}' },
      };
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

  // The queue's own listing. Without it the create queue is addressable only by
  // job id, so a PC that enqueued a background run can't see what else is in
  // flight — `agentbox queue list` would show its local jobs and nothing else.
  if (req.method === 'GET' && req.path === REMOTE_BOXES_PREFIX) {
    if (!store.listCreateJobs) {
      return { status: 501, body: { error: 'create-job queue not available on this store' } };
    }
    const jobs = await store.listCreateJobs({ limit: 100 });
    return { status: 200, body: { jobs } };
  }

  // A job's progress log, by byte offset. The worker's per-step lines (clone,
  // seed, the provider's own create output) exist only as a file on the plane
  // that ran the job — without this the PC's `create --via-hub` / `<provider>
  // claude` sits on one static "running" line for the minutes a cloud create
  // takes, because the job row carries a status and nothing else.
  if (req.method === 'GET' && req.path.endsWith('/logs')) {
    const id = decodeURIComponent(
      req.path.slice(`${REMOTE_BOXES_PREFIX}/`.length, -'/logs'.length),
    );
    if (id.length === 0) return { status: 404, body: { error: 'no such job' } };
    if (!isSafeJobId(id)) return { status: 400, body: { error: 'invalid job id' } };
    if (!deps.readJobLog) {
      return { status: 501, body: { error: 'job logs not available on this plane' } };
    }
    const offset = Number.parseInt(req.query?.get('offset') ?? '0', 10);
    const tail = await deps.readJobLog(id, Number.isFinite(offset) ? offset : 0);
    return { status: 200, body: tail };
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
    // The control box also holds its OWN copy of a box it built: a `state.json`
    // record and the per-box SSH key dir the provider minted. Reaping only the
    // Store left those behind, so a box destroyed from the PC kept showing as
    // `running` in `hub boxes list`, the dashboard and the tray (both read local
    // state first, and a cloud row renders from `cloud.lastState` with no live
    // probe), with its private key still on disk.
    const localRemoved = await reapLocalBoxState(boxId, reg?.sandboxId, log);
    if (!existed && !reg && custodyRemoved === 0 && !localRemoved) {
      return { status: 404, body: { error: 'no such box' } };
    }
    log(
      `reaped box ${boxId} (registration=${String(existed)}, custody=${String(custodyRemoved)}, local=${String(localRemoved)})`,
    );
    return { status: 200, body: { boxId, removed: existed, custodyRemoved, localRemoved } };
  }

  return { status: 405, body: { error: 'method not allowed' } };
}

/**
 * Drop the control box's own record of a box whose cloud resource is already
 * gone: the `state.json` entry and the per-box SSH key dir the provider minted.
 *
 * Scoped to exactly this box's sandbox id — never a sweep. `prune --all`
 * enumerates box dirs by the docker-shaped `<id>-<n>-<mnemonic>` run-dir name,
 * which a VPS provider's sandboxId-keyed dir never matches, so a broad cleanup
 * there would delete a LIVE box's private key.
 *
 * Best-effort and idempotent: this runs on a plain relay too, where there is no
 * local record to remove.
 */
async function reapLocalBoxState(
  boxId: string,
  sandboxId: string | undefined,
  log: (line: string) => void,
): Promise<boolean> {
  let removed = false;
  try {
    const { mutateState, readState, boxSshDirForProvider } = await import('@agentbox/sandbox-core');
    const state = await readState();
    const record = state.boxes.find((b) => b.id === boxId);
    if (record) {
      await mutateState((s) => ({ ...s, boxes: s.boxes.filter((b) => b.id !== boxId) }));
      removed = true;
      const key = record.cloud?.sandboxId ?? sandboxId;
      const provider = record.provider;
      if (key && provider) {
        const sshDir = boxSshDirForProvider(provider, key);
        // `<...>/boxes/<sandboxId>/ssh` — take the box dir, not just the keys.
        if (sshDir) await rm(dirname(sshDir), { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch (err) {
    log(`local reap for ${boxId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return removed;
}
