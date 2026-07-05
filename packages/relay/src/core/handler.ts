import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { GitHubAppLeaser } from '../github-app.js';
import { leaseTokenResult } from '../lease.js';
import { gateApproval } from '../permission.js';
import { isValidBoxStatus } from '../status-store.js';
import type { Store } from '../store/store.js';
import { applyStoreOp, isStoreRpcMethod, type StoreRpcRequest } from '../store/store-rpc.js';
import { resolveWorktree } from '../worktree.js';
import type { CreateJobRequest } from '../store/store.js';
import { isScratchBranch } from '@agentbox/core';
import type {
  BoxRegistration,
  GitRpcParams,
  PostEventBody,
  PostRpcBody,
  RegisterBoxBody,
} from '../types.js';

/**
 * Framework-agnostic request/response dispatch for the HOSTED control plane
 * (the Next.js app on Vercel / self-host). It reuses the relay's shared
 * primitives — the {@link Store}, {@link gateApproval}, the GitHub-App leaser —
 * but is decoupled from node:http and from host execution: it never runs git
 * locally (no worktree on the hosted plane) and obtains approvals via the poll
 * mailbox, never by blocking. The long-lived laptop relay keeps using
 * `server.ts` (node:http, host execution, SSE); they share the same core
 * building blocks but not this handler.
 *
 * Host-local RPCs (cp/download/checkpoint, and the docker-style git.push/fetch)
 * are intentionally rejected here — they require a host, which the plane has
 * none of. Cloud boxes push via `git.lease-token` instead.
 */
export interface GenericRequest {
  method: string;
  /** URL pathname, e.g. "/rpc" or "/rpc/status/<id>". */
  path: string;
  query: URLSearchParams;
  /** The Bearer token, already extracted ('' when absent). */
  bearer: string;
  /** Raw request body (already read by the adapter; '' for GET). */
  bodyText: string;
}

export interface RelayResponse {
  status: number;
  /** JSON-serializable body (omitted → empty response). */
  body?: unknown;
}

export interface ControlPlaneDeps {
  store: Store;
  /** GitHub-App leaser for `git.lease-token`; null → leasing returns a clear error. */
  leaser: GitHubAppLeaser | null;
  /** Admin bearer gating `/admin/*` + `/remote/*`. Required (fail-closed). */
  adminToken: string;
  /**
   * Providers this plane can CREATE boxes on (gates `POST /remote/boxes`).
   * `undefined`/empty → all providers allowed. A serverless plane (Vercel, no
   * worker) sets this to the SDK-native set so it cleanly refuses providers
   * whose `create()` needs host execution (e.g. hetzner).
   */
  createProviders?: string[];
  log?: (line: string) => void;
}

function ok(body: unknown, status = 200): RelayResponse {
  return { status, body };
}
function err(status: number, error: string): RelayResponse {
  return { status, body: { error } };
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

const HOST_LOCAL_METHODS = new Set([
  'git.push',
  'git.fetch',
  'cp.toHost',
  'cp.fromHost',
  'download.workspace',
  'download.env',
  'download.config',
  'download.claude',
  'checkpoint.create',
]);

/**
 * Dispatch one control-plane request. The hosted plane's gating is fixed:
 * `/admin/*` and `/remote/*` always require the admin bearer (never loopback),
 * and approvals are always poll-mode.
 */
export async function handleRelayRequest(
  req: GenericRequest,
  deps: ControlPlaneDeps,
): Promise<RelayResponse> {
  const { store, leaser } = deps;
  const log = deps.log ?? (() => {});

  if (deps.adminToken.length === 0) {
    // Fail closed — a hosted plane with no admin token must never serve /admin/*.
    // 503 (not 500): a deploy that hasn't had its secrets set yet is "not ready",
    // not crashed. healthz is handled before this in the Web adapter (lib/plane.ts).
    return err(503, 'control plane not configured: admin token unset');
  }

  if (req.method === 'GET' && req.path === '/healthz') {
    return ok({
      ok: true,
      boxes: await store.countBoxes(),
      events: await store.countEvents(),
      controlPlane: true,
    });
  }

  const isAdmin = req.path.startsWith('/admin/') || req.path.startsWith('/remote/');
  if (isAdmin && !timingSafeEqualStr(req.bearer, deps.adminToken)) {
    return err(401, 'invalid admin token');
  }

  // --- box endpoints (per-box bearer) ---
  if (req.method === 'POST' && req.path === '/events') {
    const reg = await store.authenticateBox(req.bearer);
    if (!reg) return err(401, 'unknown box token');
    const body = parseJson<PostEventBody>(req.bodyText);
    if (!body || typeof body.type !== 'string' || body.type.length === 0) {
      return err(400, 'missing "type" string');
    }
    if (body.type === 'box-status') {
      if (!isValidBoxStatus(body.payload)) return err(400, 'invalid box-status payload');
      await store.setStatus(reg.boxId, reg.name, reg.projectIndex, body.payload);
      return ok({ ok: true }, 202);
    }
    const ev = await store.appendEvent({
      boxId: reg.boxId,
      type: body.type,
      ts: typeof body.ts === 'string' ? body.ts : undefined,
      payload: body.payload,
    });
    return ok({ id: ev.id }, 202);
  }

  if (req.method === 'POST' && req.path === '/rpc') {
    const reg = await store.authenticateBox(req.bearer);
    if (!reg) return err(401, 'unknown box token');
    const body = parseJson<PostRpcBody>(req.bodyText);
    if (!body || typeof body.method !== 'string' || body.method.length === 0) {
      return err(400, 'missing "method" string');
    }
    log(`rpc box=${reg.boxId} method=${body.method}`);
    return dispatchRpc(reg, body.method, body.params, deps);
  }

  if (req.method === 'GET' && req.path.startsWith('/rpc/status/')) {
    const reg = await store.authenticateBox(req.bearer);
    if (!reg) return err(401, 'unknown box token');
    const promptId = decodeURIComponent(req.path.slice('/rpc/status/'.length));
    const row = await store.getPrompt(promptId);
    if (!row || row.boxId !== reg.boxId) return err(404, 'no such prompt');
    if (row.status === 'pending') return ok({ status: 'pending' });
    if (row.answer !== 'y' || row.cancelled) {
      return ok({ status: 'done', result: { exitCode: 10, stdout: '', stderr: 'denied by user\n' } });
    }
    const cached = row.result;
    const result = cached ?? (await runApproved(reg, row.method, leaser));
    if (!cached) await store.setPromptResult(promptId, result);
    return ok({ status: 'done', result });
  }

  // --- admin endpoints (admin bearer, checked above) ---
  if (req.method === 'POST' && req.path === '/admin/register-box') {
    const body = parseJson<RegisterBoxBody>(req.bodyText);
    if (!body || !body.boxId || !body.token || typeof body.name !== 'string') {
      return err(400, 'expected {boxId, token, name}');
    }
    const reg: BoxRegistration = {
      boxId: body.boxId,
      token: body.token,
      name: body.name,
      kind: body.kind === 'cloud' ? 'cloud' : 'docker',
      backend: body.backend || undefined,
      registeredAt: new Date().toISOString(),
      containerName: body.containerName || undefined,
      createdAt: body.createdAt || undefined,
      projectIndex:
        typeof body.projectIndex === 'number' && body.projectIndex > 0
          ? Math.trunc(body.projectIndex)
          : undefined,
      worktrees: Array.isArray(body.worktrees) ? body.worktrees : undefined,
      previewUrl: body.previewUrl || undefined,
      previewToken: body.previewToken || undefined,
      bridgeToken: body.bridgeToken || undefined,
      autoApproveHostActions: body.autoApproveHostActions === true,
      autoApproveSafeHostActions: body.autoApproveSafeHostActions !== false,
      originUrl: body.originUrl || undefined,
    };
    await store.registerBox(reg);
    log(`registered ${reg.kind ?? 'docker'} box ${reg.boxId} (${reg.name})`);
    return ok(null, 204);
  }

  if (req.method === 'POST' && req.path === '/admin/forget-box') {
    const body = parseJson<{ boxId?: string }>(req.bodyText);
    if (!body?.boxId) return err(400, 'expected {boxId}');
    await store.forgetBox(body.boxId);
    await store.deleteStatus(body.boxId);
    return ok(null, 204);
  }

  if (req.method === 'GET' && req.path === '/admin/box-status') {
    const box = req.query.get('box') ?? '';
    const status = box ? await store.getStatus(box) : undefined;
    return status ? ok(status) : err(404, 'no status for box');
  }

  if (req.method === 'GET' && req.path === '/admin/events') {
    const since = Number.parseInt(req.query.get('since') ?? '0', 10) || 0;
    const box = req.query.get('box') ?? undefined;
    return ok({ events: await store.listEvents(since, box ?? undefined) });
  }

  if (req.method === 'GET' && req.path === '/admin/app/repo-installed') {
    // Whether the GitHub App is installed on owner/repo — lets a CLI without a
    // local App key (a laptop pointed at this plane) decide whether to prompt
    // the user to authorize the repo. No token is minted.
    if (!leaser) return err(503, 'no GitHub App configured on this control plane');
    const owner = req.query.get('owner') ?? '';
    const repo = req.query.get('repo') ?? '';
    if (!owner || !repo) return err(400, 'missing owner/repo query params');
    try {
      return ok({ installed: await leaser.isRepoInstalled(owner, repo) });
    } catch (e) {
      return err(502, `installation check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (req.method === 'GET' && req.path === '/admin/registry') {
    const redacted = (await store.listBoxes()).map((r) => ({
      boxId: r.boxId,
      name: r.name,
      kind: r.kind,
      registeredAt: r.registeredAt,
      projectIndex: r.projectIndex,
      originUrl: r.originUrl,
    }));
    return ok({ boxes: redacted });
  }

  if (req.method === 'GET' && req.path === '/admin/prompts') {
    const boxId = req.query.get('boxId') ?? '';
    if (boxId.length === 0) return err(400, 'missing boxId query param');
    const pending = (await store.listPendingPrompts(boxId)).map((r) => r.ev);
    return ok({ prompts: pending });
  }

  if (req.method === 'POST' && req.path === '/admin/prompts/answer') {
    const body = parseJson<{ id?: string; answer?: string; cancelled?: boolean }>(req.bodyText);
    if (!body?.id || (body.answer !== 'y' && body.answer !== 'n')) {
      return err(400, 'expected {id, answer:"y"|"n", cancelled?}');
    }
    const hit = await store.answerPrompt(body.id, body.answer, body.cancelled);
    return hit ? ok(null, 204) : err(404, 'no pending prompt with that id');
  }

  if (req.method === 'POST' && req.path === '/admin/store') {
    // Generic Store RPC for a federated laptop relay's RemoteStore. Admin-gated
    // (checked above); the method name is an explicit allow-list.
    const body = parseJson<StoreRpcRequest>(req.bodyText);
    if (!body || typeof body.method !== 'string' || !Array.isArray(body.args)) {
      return err(400, 'expected {method, args}');
    }
    if (!isStoreRpcMethod(body.method)) return err(400, `unknown store op: ${body.method}`);
    const result = await applyStoreOp(store, body.method, body.args);
    return ok({ result: result ?? null });
  }

  if (req.method === 'POST' && req.path === '/remote/boxes') {
    // Enqueue a durable create job; a worker (self-host loop / Vercel cron)
    // drains it and clones the repo into a fresh cloud box via a leased token.
    if (!store.enqueueCreateJob) return err(501, 'create-job queue not available on this store');
    const body = parseJson<CreateJobRequest>(req.bodyText);
    if (!body || typeof body.repoUrl !== 'string' || typeof body.provider !== 'string') {
      return err(400, 'expected {repoUrl, provider, branch?, name?, agent?, prompt?}');
    }
    const allowed = deps.createProviders;
    if (allowed && allowed.length > 0 && !allowed.includes(body.provider)) {
      return err(
        400,
        `provider '${body.provider}' is not supported by this control plane (allowed: ${allowed.join(', ')})`,
      );
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
    return ok({ jobId: id }, 202);
  }

  if (req.method === 'GET' && req.path.startsWith('/remote/boxes/')) {
    if (!store.getCreateJob) return err(501, 'create-job queue not available on this store');
    const id = decodeURIComponent(req.path.slice('/remote/boxes/'.length));
    const job = await store.getCreateJob(id);
    return job ? ok(job) : err(404, 'no such job');
  }

  return err(404, 'not found');
}

async function dispatchRpc(
  reg: BoxRegistration,
  method: string,
  params: unknown,
  deps: ControlPlaneDeps,
): Promise<RelayResponse> {
  if (method === 'git.lease-token') {
    const p = params as GitRpcParams | undefined;
    const worktree = resolveWorktree(reg, p?.path ?? '/workspace');
    // Lease-token grants a *repo-scoped* push token — the box can then push any
    // branch with it, so (unlike the relay-driven git.push, where the relay
    // picks the exact branch) the sanctioned-branch auto-approve does NOT apply
    // here. Only the box's own scratch branch bypasses; everything else parks
    // for a human.
    const isAgentboxBranch = isScratchBranch(worktree?.branch);
    if (!isAgentboxBranch) {
      const gate = await gateApproval({ mode: 'poll', store: deps.store }, reg.boxId, method, params, {
        kind: 'confirm',
        message: `Allow box ${reg.name} to lease a push token for ${reg.originUrl ?? 'its repo'}?`,
        detail: `branch ${worktree?.branch ?? '(unregistered)'}`,
        defaultAnswer: 'n',
        context: { command: 'git lease-token', cwd: p?.path },
      });
      if (gate.kind === 'pending') return ok({ status: 'pending', promptId: gate.promptId }, 202);
      if (gate.kind === 'deny') {
        return ok({ exitCode: 10, stdout: '', stderr: 'denied by user\n' }, 500);
      }
    }
    const result = await leaseTokenResult(deps.leaser, reg);
    return ok(result, result.exitCode === 0 ? 200 : 500);
  }

  if (method === 'browser.open') {
    // The box already opened it locally; just record the event (no host mirror).
    const p = params as { url?: unknown } | undefined;
    if (typeof p?.url === 'string') {
      await deps.store.appendEvent({ boxId: reg.boxId, type: 'browser-open', payload: { url: p.url } });
    }
    return ok({ exitCode: 0, stdout: '', stderr: '' });
  }

  if (HOST_LOCAL_METHODS.has(method)) {
    return ok(
      {
        exitCode: 64,
        stdout: '',
        stderr: `${method}: not available on the hosted control plane (no host). Cloud boxes push via git.lease-token.\n`,
      },
      501,
    );
  }

  return ok({ error: 'rpc method not implemented', method }, 501);
}

/** Execute a poll-approved action on the hosted plane. Only leasing is parkable here. */
async function runApproved(
  reg: BoxRegistration,
  method: string,
  leaser: GitHubAppLeaser | null,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (method === 'git.lease-token') return leaseTokenResult(leaser, reg);
  return { exitCode: 64, stdout: '', stderr: `relay: no approved-action executor for ${method}\n` };
}
