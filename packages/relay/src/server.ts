import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeCloudAction, refreshCloudPreviewUrl } from './host-actions.js';
import { HostActionQueue } from './host-action-queue.js';
import { BoxNotices } from './notices.js';
import { hostOpenCommand } from '@agentbox/sandbox-core';
import { getConnector } from '@agentbox/integrations';
import {
  assertGhReady,
  checkoutGuards,
  GH_API_ENDPOINT_REFUSAL,
  GH_PR_READ_ONLY_OPS,
  GH_RUN_READ_ONLY_OPS,
  injectPrCreateHead,
  isAllowedGhApiEndpoint,
  refuseGhApiCall,
  isGhPrOp,
  isGhRunOp,
  PR_CREATE_NO_HEAD_REFUSAL,
  prCreateNeedsHead,
  refuseCheckoutByDefault,
  refuseMergeBypass,
  runHostGh,
  type GhApiRpcParams,
  type GhPrOp,
  type GhPrRpcParams,
  type GhRunOp,
  type GhRunRpcParams,
} from './gh.js';
import { hashRpcParams, HostInitiatedTokens } from './host-initiated.js';
import {
  assertIntegrationReady,
  makeIntegrationOpRefusal,
  parseIntegrationMethod,
  refuseIfIntegrationDisabled,
  refuseIntegrationCall,
  runHostIntegration,
  type IntegrationRpcParams,
} from './integrations.js';
import { askPrompt, isPromptAnswerBody, PendingPrompts, PromptSubscribers } from './prompts.js';
import { BoxRegistry, EventBuffer } from './registry.js';
import { BoxStatusStore, isValidBoxStatus } from './status-store.js';
import { MemoryStore } from './store/memory-store.js';
import type { Store } from './store/store.js';
import { DEFAULT_BOX_RELAY_PORT } from './types.js';
import type {
  BoxRegistration,
  BoxWorktree,
  BridgeActionResultBody,
  BridgePollResponse,
  BrowserOpenRpcParams,
  CheckpointRpcParams,
  ClearNoticeBody,
  CpRpcParams,
  DownloadKind,
  DownloadRpcParams,
  GitRpcParams,
  GitRpcResult,
  HostAction,
  PostEventBody,
  PostRpcBody,
  PromptAnswerBody,
  RegisterBoxBody,
  RelayEvent,
  SetNoticeBody,
} from './types.js';

export type RelayMode = 'host' | 'box';

export interface RelayServerOptions {
  port: number;
  /** Bind address; defaults to '0.0.0.0' so containers can reach the relay across the local docker network OR the Daytona preview proxy can hit the in-sandbox box-mode relay. */
  host?: string;
  logger?: (line: string) => void;
  /**
   * 'host' (default): host relay process; executes host-only RPCs locally
   * via `spawn` and serves `/admin/*` to the CLI / wrapper.
   * 'box': in-sandbox relay; host-only RPCs enqueue on a `HostActionQueue`
   * for the host poller to drain via `/bridge/*`.
   */
  mode?: RelayMode;
  /**
   * Required when `mode === 'box'`: bearer for the box-only `/bridge/*`
   * routes. Distinct from per-box `BoxRegistration.token` so a compromised
   * in-box agent cannot impersonate the host poller.
   */
  bridgeToken?: string;
  /**
   * Control-box mode: this `host`-mode relay runs on an always-on cloud box
   * exposed publicly (behind the provider's HTTPS proxy) rather than on a
   * laptop's loopback. When set, `/admin/*` (and `/remote/*`) are gated by a
   * bearer match against `adminToken` instead of the source-IP loopback check
   * — the provider proxy can present requests as loopback, so loopback is NOT
   * trusted here. Requires a non-empty `adminToken` (enforced at startup).
   */
  controlBox?: boolean;
  /**
   * Bearer required on `/admin/*` and `/remote/*` when `controlBox` is set.
   * Ignored otherwise (the laptop relay stays loopback-gated).
   */
  adminToken?: string;
  /**
   * Persisted-state backend. Defaults to an in-memory store wrapping the
   * relay's historical in-memory structures (the laptop relay + tests). A
   * hosted control plane injects a Postgres-backed store; a federated laptop
   * relay injects a RemoteStore. See `./store/store.ts`.
   */
  store?: Store;
}

export interface RelayServerHandle {
  server: Server;
  /** The persisted-state backend the handlers use (memory by default). */
  store: Store;
  registry: BoxRegistry;
  events: EventBuffer;
  statusStore: BoxStatusStore;
  prompts: PendingPrompts;
  subscribers: PromptSubscribers;
  notices: BoxNotices;
  /** Present only in `mode === 'box'`: the parking lot for host-only RPCs. */
  hostActions?: HostActionQueue;
  url: string;
  /**
   * Wire a "kick the queue scheduler now" callback. Called by
   * `POST /admin/queue/enqueue` so a freshly-submitted background job doesn't
   * wait up to one tick for the relay to notice the new manifest.
   * No-op until set; the queue still picks the job up via the periodic tick.
   */
  setQueuePoke: (fn: () => void) => void;
  close: () => Promise<void>;
}

/** Event type whose payload is a durable BoxStatus snapshot (persisted, not ringed). */
const BOX_STATUS_EVENT = 'box-status';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB hard cap; relay is for control-plane traffic, not payloads.
const GIT_RPC_TIMEOUT_MS = 120_000; // git push/pull can be slow on big repos.
const CHECKPOINT_RPC_TIMEOUT_MS = 600_000; // capturing node_modules/build trees can be slow.
const DOWNLOAD_RPC_TIMEOUT_MS = 600_000; // claude/workspace pulls over rsync can take minutes.
const CP_RPC_TIMEOUT_MS = 300_000; // single-file/dir cp; tar pipe through docker exec.
const BROWSER_OPEN_RPC_TIMEOUT_MS = 15_000; // `open` hands off to the browser and returns at once.
const BROWSER_OPEN_PROMPT_TTL_MS = 25_000; // the "open on host too?" offer auto-dismisses if ignored.
const SSE_HEARTBEAT_MS = 15_000; // every 15s; wrapper reconnects if it sees no traffic for ~30s.

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  contentType: string = 'application/json',
): void {
  const text = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  res.statusCode = status;
  if (text.length > 0) {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', Buffer.byteLength(text).toString());
    res.end(text);
  } else {
    res.end();
  }
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.length === 0) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(text) as T);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string {
  const raw = req.headers.authorization;
  if (typeof raw !== 'string') return '';
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1]!.trim() : '';
}

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr.startsWith('127.')
  );
}

/** Constant-time string compare; false on length mismatch (never throws). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Build the relay HTTP server. Routes:
 *   POST /events                — bearer auth (box token), appends to ring buffer.
 *   POST /rpc                   — bearer auth; dispatches git.push/fetch, cp.*, download.*, checkpoint.create on the host.
 *   POST /admin/register-box    — loopback only.
 *   POST /admin/forget-box      — loopback only.
 *   GET  /admin/box-status      — loopback only; query `box`; latest snapshot.
 *   GET  /admin/events          — loopback only; query `box`, `since`.
 *   GET  /admin/registry        — loopback only; list registered boxes (token redacted).
 *   GET  /admin/prompts         — loopback only; query `boxId`; one-shot list of pending host-action approvals.
 *   GET  /admin/prompts/stream  — loopback only; SSE; pushes prompt-ask/prompt-resolved/notice-set/notice-clear/ping events.
 *   POST /admin/prompts/answer  — loopback only; resolves a pending prompt by id.
 *   POST /admin/host-initiated/mint — loopback only; mints a one-time token scoped to (boxId, method).
 *   POST /admin/notices/set     — loopback only; sets an informational box notice (returns {id}).
 *   POST /admin/notices/clear   — loopback only; clears a box notice by id.
 *   GET  /healthz               — liveness + capability probe (no auth); reports {pid, cliEntry}.
 */
export function createRelayServer(opts: RelayServerOptions): RelayServerHandle {
  const log = opts.logger ?? (() => {});
  const registry = new BoxRegistry();
  const events = new EventBuffer();
  const statusStore = new BoxStatusStore();
  const prompts = new PendingPrompts();
  const subscribers = new PromptSubscribers();
  const notices = new BoxNotices(subscribers);
  // The persisted-state seam. Defaults to a MemoryStore wrapping the concrete
  // instances above, so the laptop relay + tests behave exactly as before; a
  // hosted control plane injects a Postgres-backed store instead. Handlers go
  // through `store.*`; the concrete instances stay exposed on the handle for
  // the autopause / queue loops (bin.ts) and the unit tests that read them.
  const store: Store = opts.store ?? new MemoryStore({ registry, events, statusStore });
  // Per-box `box.autoApproveHostActions`: when a box registered with the flag,
  // host-action confirms resolve to 'y' without a prompt, but every bypass
  // lands in the event ring buffer (visible via `/admin/events`) so it's
  // auditable. Reads the concrete registry/events synchronously (not the async
  // store): `askPrompt` broadcasts to SSE subscribers synchronously, so this
  // gate must stay sync. The MemoryStore wraps these same instances, so the
  // sync policy view and the async store view never diverge on the laptop relay.
  prompts.setAutoApprovePolicy({
    shouldAutoApprove: (boxId) => registry.get(boxId)?.autoApproveHostActions === true,
    audit: (boxId, params) => {
      events.append({
        boxId,
        type: 'host-action-auto-approved',
        payload: {
          command: params.context?.command,
          argv: params.context?.argv,
          message: params.message,
        },
      });
      log(`auto-approved host action for ${boxId}: ${params.context?.command ?? params.message}`);
    },
  });
  const hostInitiatedTokens = new HostInitiatedTokens();
  let queuePoke: (() => void) | null = null;
  const host = opts.host ?? '0.0.0.0';
  const mode: RelayMode = opts.mode ?? 'host';
  // Box mode parks host-only RPCs until the host poller answers; host mode
  // executes them inline (the historical behavior).
  const hostActions = mode === 'box' ? new HostActionQueue() : null;
  if (mode === 'box' && (!opts.bridgeToken || opts.bridgeToken.length === 0)) {
    throw new Error("relay mode='box' requires a non-empty bridgeToken");
  }
  const bridgeToken = opts.bridgeToken ?? '';
  // Control-box mode gates /admin/* (and /remote/*) on a bearer instead of
  // source-IP loopback, because the relay is reachable from the internet via
  // the provider's HTTPS proxy. Fail closed: refuse to boot in control-box
  // mode without a token rather than silently leaving admin loopback-open.
  const controlBox = opts.controlBox ?? false;
  const adminToken = opts.adminToken ?? '';
  if (controlBox && adminToken.length === 0) {
    throw new Error('relay controlBox mode requires a non-empty adminToken');
  }

  // Host-mode pollers for cloud-tagged boxes; started on /admin/register-box,
  // stopped on /admin/forget-box. Lazy import to keep host-mode startup free
  // of cloud-poller deps until actually needed.
  type CloudPollersModule = typeof import('./cloud-poller.js');
  let pollers: InstanceType<CloudPollersModule['CloudBoxPollers']> | null = null;
  async function getPollers(): Promise<InstanceType<CloudPollersModule['CloudBoxPollers']>> {
    if (!pollers) {
      const mod: CloudPollersModule = await import('./cloud-poller.js');
      pollers = new mod.CloudBoxPollers();
    }
    return pollers;
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log(`relay: handler error: ${msg}`);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'relay'}`);
    const route = `${req.method ?? 'GET'} ${url.pathname}`;

    if (route === 'GET /healthz') {
      // `cliEntry` and `pid` let the host-side `ensureRelay` distinguish a
      // *capable* relay from one that's merely alive: a relay spawned without
      // AGENTBOX_CLI_ENTRY silently fails every cp/download/checkpoint host
      // action (exit 64) for its whole lifetime. Reporting it here lets the
      // caller reclaim (kill by `pid`) and respawn instead of reusing it.
      send(res, 200, {
        ok: true,
        boxes: await store.countBoxes(),
        events: await store.countEvents(),
        pid: process.pid,
        cliEntry: Boolean(process.env.AGENTBOX_CLI_ENTRY),
        // The spawning CLI's version/commit (inherited via env at spawn time).
        // `version` lets host-side ensureRelay reclaim a relay left over from a
        // different agentbox version; `commit` is observability-only.
        version: process.env.AGENTBOX_CLI_VERSION || undefined,
        commit: process.env.AGENTBOX_CLI_COMMIT || undefined,
      });
      return;
    }

    // Bridge routes are the host poller's view into an in-sandbox box-mode
    // relay. They are bearer-authed with the per-relay bridgeToken and
    // exist only when mode === 'box'. No loopback check: the Daytona
    // preview proxy reaches them from non-loopback IPs.
    if (url.pathname.startsWith('/bridge/')) {
      if (mode !== 'box' || !hostActions) {
        send(res, 404, { error: 'bridge routes available only in mode=box' });
        return;
      }
      if (bearerToken(req) !== bridgeToken) {
        send(res, 401, { error: 'invalid bridge token' });
        return;
      }
      if (route === 'GET /bridge/healthz') {
        send(res, 200, { ok: true, queued: hostActions.size(), events: events.size() });
        return;
      }
      if (route === 'GET /bridge/poll') {
        const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0;
        const newEvents = await store.listEvents(since);
        const lastId = newEvents.length > 0 ? newEvents[newEvents.length - 1]!.id : since;
        const actions = hostActions.drain();
        // A box-mode relay only ever has one registered box (itself). The
        // status snapshot — if any has been pushed — belongs to that box.
        const only = (await store.listBoxes())[0];
        const status = only ? (await store.getStatus(only.boxId)) ?? null : null;
        const reply: BridgePollResponse = {
          actions,
          events: newEvents,
          status,
          cursor: lastId,
        };
        send(res, 200, reply);
        return;
      }
      if (route === 'POST /bridge/action-result') {
        const body = await readJsonBody<BridgeActionResultBody>(req);
        if (
          !body ||
          typeof body.id !== 'string' ||
          body.id.length === 0 ||
          typeof body.exitCode !== 'number'
        ) {
          send(res, 400, { error: 'expected {id, exitCode, stdout, stderr}' });
          return;
        }
        const ok = hostActions.resolve(body.id, {
          exitCode: body.exitCode,
          stdout: typeof body.stdout === 'string' ? body.stdout : '',
          stderr: typeof body.stderr === 'string' ? body.stderr : '',
        });
        if (!ok) {
          send(res, 404, { error: 'no parked action with that id' });
          return;
        }
        send(res, 204, null);
        return;
      }
      send(res, 404, { error: 'not found', route });
      return;
    }

    // Admin endpoints are reachable from loopback only. The relay binds to
    // 0.0.0.0 so containers can reach /events and /rpc via host.docker.internal,
    // but admin operations (register-box, forget-box, list events, etc.) are
    // for the host CLI and must not be exposed to boxes.
    //
    // In control-box mode the relay is exposed publicly behind the provider's
    // HTTPS proxy, which can present requests as loopback — so loopback is NOT
    // trusted. Admin (and /remote/*) require a valid admin bearer instead.
    if (url.pathname.startsWith('/admin/') || url.pathname.startsWith('/remote/')) {
      if (controlBox) {
        if (!timingSafeEqualStr(bearerToken(req), adminToken)) {
          send(res, 401, { error: 'invalid admin token' });
          return;
        }
      } else if (url.pathname.startsWith('/remote/')) {
        // /remote/* is a control-box-only surface; off the control box it does
        // not exist (avoid advertising a half-wired endpoint on laptop relays).
        send(res, 404, { error: 'not found', route });
        return;
      } else if (!isLoopbackAddress(req.socket.remoteAddress)) {
        send(res, 403, { error: 'admin endpoints are loopback-only' });
        return;
      }
    }

    if (route === 'POST /events') {
      const reg = await authBox(req, res);
      if (!reg) return;
      const body = await readJsonBody<PostEventBody>(req);
      if (!body || typeof body.type !== 'string' || body.type.length === 0) {
        send(res, 400, { error: 'missing "type" string' });
        return;
      }
      // box-status is durable state, not an event: persist the latest snapshot
      // per box and skip the ring buffer (a 15s heartbeat per box would
      // otherwise evict the useful git/service events from the 1000-cap ring).
      if (body.type === BOX_STATUS_EVENT) {
        if (!isValidBoxStatus(body.payload)) {
          send(res, 400, { error: 'invalid box-status payload' });
          return;
        }
        await store.setStatus(reg.boxId, reg.name, reg.projectIndex, body.payload);
        log(`box-status box=${reg.boxId}`);
        send(res, 202, { ok: true });
        return;
      }
      const ev = await store.appendEvent({
        boxId: reg.boxId,
        type: body.type,
        ts: typeof body.ts === 'string' ? body.ts : undefined,
        payload: body.payload,
      });
      log(`event ${String(ev.id)} box=${reg.boxId} type=${body.type}`);
      send(res, 202, { id: ev.id });
      return;
    }

    if (route === 'POST /rpc') {
      const reg = await authBox(req, res);
      if (!reg) return;
      const body = await readJsonBody<PostRpcBody>(req);
      if (!body || typeof body.method !== 'string' || body.method.length === 0) {
        send(res, 400, { error: 'missing "method" string' });
        return;
      }
      log(`rpc box=${reg.boxId} method=${body.method}`);
      // Box-mode: every host-only RPC (anything except the in-sandbox-local
      // `browser.open` notification) is parked on the HostActionQueue. The
      // host's CloudBoxPoller drains via `/bridge/poll`, executes on the
      // host (with the existing `askPrompt` gate for `git.push`), and POSTs
      // the result back to `/bridge/action-result`, which resolves the
      // awaited Promise here and unblocks the in-box `/rpc` caller.
      if (mode === 'box' && hostActions && body.method !== 'browser.open') {
        const queued = await hostActions.enqueue(reg.boxId, body.method, body.params);
        const status = queued.exitCode === 0 ? 200 : 500;
        send(res, status, queued);
        return;
      }
      if (body.method === 'git.push' || body.method === 'git.fetch') {
        // Cloud box reaching a host-mode relay directly over the forwarder
        // (the control-box model): there is no host worktree to push from, so
        // run the cloud bundle pull-back executor. It does its own gating and,
        // in control-box mode, pushes to origin with the PAT. (On a laptop
        // relay this would still work via the host workspace, but cloud boxes
        // normally reach the laptop via the poller, not this path.)
        if (reg.kind === 'cloud') {
          const action: HostAction = {
            id: '',
            boxId: reg.boxId,
            method: body.method,
            params: body.params,
            createdAt: new Date().toISOString(),
          };
          const result = await executeCloudAction(action, {
            backendName: reg.backend ?? '',
            boxId: reg.boxId,
            boxName: reg.name,
            prompts,
            subscribers,
            hostInitiatedTokens,
            controlBox,
            githubToken: process.env.GH_TOKEN,
            log,
          });
          send(res, result.exitCode === 0 ? 200 : 500, result);
          return;
        }
        // Only `push` mutates the user's remote; fetch is read-only and noisy.
        // Per-box `agentbox/<name>` branches are the box's own scratch branch
        // — pushes to them are the whole point of agentbox, so they bypass
        // the y/N gate. Any other branch still prompts.
        if (body.method === 'git.push') {
          const params = body.params as GitRpcParams | undefined;
          const worktree = resolveWorktree(reg, params?.path ?? '/workspace');
          const isAgentboxBranch = worktree?.branch.startsWith('agentbox/') ?? false;
          // Host-initiated pushes (driven by `agentbox git push <box>`) skip
          // the confirm prompt — but only if the host CLI minted a valid,
          // unexpired, scope-matched, params-hash-bound token via
          // /admin/host-initiated/mint. If a token is *present* but doesn't
          // validate (wrong scope, mutated params, expired, replayed), reject
          // hard: that's an attack signal (the only way to get a token is to
          // mint one host-side, and a legitimate host call always sends what
          // it minted for). Fall through to the prompt only when no token was
          // claimed — that's the normal agent-initiated path.
          const tokenClaimed = typeof params?.hostInitiated === 'string';
          const incomingHash = hashRpcParams(params);
          const hostInitiatedOk =
            !isAgentboxBranch &&
            tokenClaimed &&
            hostInitiatedTokens.consume(params?.hostInitiated, reg.boxId, 'git.push', incomingHash);
          if (!isAgentboxBranch && tokenClaimed && !hostInitiatedOk) {
            send(res, 500, {
              exitCode: 10,
              stdout: '',
              stderr:
                'host-initiated token rejected: invalid, expired, or bound to different params\n',
            });
            return;
          }
          if (!isAgentboxBranch && !hostInitiatedOk) {
            const verdict = await askPrompt(prompts, subscribers, reg.boxId, {
              kind: 'confirm',
              message: `Allow git push from box ${reg.name}?`,
              detail: `${params?.remote ?? 'origin'} ${(params?.args ?? []).join(' ')}`.trim(),
              defaultAnswer: 'n',
              context: {
                command: 'git push',
                cwd: params?.path,
                argv: params?.args,
              },
            });
            if (verdict.answer !== 'y') {
              send(res, 500, { exitCode: 10, stdout: '', stderr: 'denied by user\n' });
              return;
            }
          }
        }
        const result = await handleGitRpc(reg, body.method, body.params as GitRpcParams | undefined);
        const status = result.exitCode === 0 ? 200 : 500;
        send(res, status, result);
        return;
      }
      if (body.method === 'cp.toHost' || body.method === 'cp.fromHost') {
        const params = body.params as CpRpcParams | undefined;
        if (!params || typeof params.boxPath !== 'string' || typeof params.hostPath !== 'string') {
          send(res, 400, { error: 'cp.* requires {boxPath, hostPath} strings' });
          return;
        }
        if (
          params.exclude !== undefined &&
          (!Array.isArray(params.exclude) || params.exclude.some((p) => typeof p !== 'string'))
        ) {
          send(res, 400, { error: 'cp.* exclude must be an array of strings' });
          return;
        }
        const direction = body.method === 'cp.toHost' ? 'box -> host' : 'host -> box';
        const pathDetail =
          body.method === 'cp.toHost'
            ? `${params.boxPath} -> ${params.hostPath}`
            : `${params.hostPath} -> ${params.boxPath}`;
        const detailParts = [pathDetail];
        if (params.exclude && params.exclude.length > 0) {
          detailParts.push(`exclude: ${params.exclude.join(', ')}`);
        }
        if (params.defaultExcludes === false) detailParts.push('(default excludes off)');
        if (params.yes) detailParts.push('(over size limit — confirmed)');
        const verdict = await askPrompt(prompts, subscribers, reg.boxId, {
          kind: 'confirm',
          message: `Allow cp (${direction}) on ${reg.name}?`,
          detail: detailParts.join('\n'),
          defaultAnswer: 'n',
          context: {
            command: body.method,
            argv: [params.boxPath, params.hostPath],
          },
        });
        if (verdict.answer !== 'y') {
          send(res, 500, { exitCode: 10, stdout: '', stderr: 'denied by user\n' });
          return;
        }
        const result = await handleCpRpc(reg, body.method, params);
        const status = result.exitCode === 0 ? 200 : 500;
        send(res, status, result);
        return;
      }
      if (body.method.startsWith('gh.pr.')) {
        const op = body.method.slice('gh.pr.'.length);
        if (!isGhPrOp(op)) {
          send(res, 400, { error: `unknown gh.pr.* op: ${op}` });
          return;
        }
        const result = await handleGhPrRpc(
          op,
          reg,
          body.params as GhPrRpcParams | undefined,
          prompts,
          subscribers,
          hostInitiatedTokens,
        );
        const status = result.exitCode === 0 ? 200 : 500;
        send(res, status, result);
        return;
      }
      if (body.method.startsWith('gh.run.')) {
        const op = body.method.slice('gh.run.'.length);
        if (!isGhRunOp(op)) {
          send(res, 400, { error: `unknown gh.run.* op: ${op}` });
          return;
        }
        const result = await handleGhRunRpc(
          op,
          reg,
          body.params as GhRunRpcParams | undefined,
          prompts,
          subscribers,
        );
        const status = result.exitCode === 0 ? 200 : 500;
        send(res, status, result);
        return;
      }
      if (body.method === 'gh.api') {
        const result = await handleGhApiRpc(reg, body.params as GhApiRpcParams | undefined);
        const status = result.exitCode === 0 ? 200 : 500;
        send(res, status, result);
        return;
      }
      if (body.method.startsWith('integration.')) {
        const result = await handleIntegrationRpc(
          body.method,
          reg,
          body.params as IntegrationRpcParams | undefined,
          prompts,
          subscribers,
          hostInitiatedTokens,
        );
        const status = result.exitCode === 0 ? 200 : 500;
        send(res, status, result);
        return;
      }
      if (body.method === 'git.clone' || body.method === 'gh.repo.clone') {
        // Clone bundle-ship-back machinery is deferred to a follow-up PR
        // (see docs/plans/gh-and-git-shims-host-only.md → Deferred follow-ups).
        // The shim + ctl plumbing is in place so the next iteration only has
        // to land the relay-side host clone + bundle + box transfer.
        send(res, 501, {
          exitCode: 64,
          stdout: '',
          stderr: `${body.method}: not yet implemented (deferred; see docs/plans/gh-and-git-shims-host-only.md). Run \`gh\` / \`git\` on the host directly for now.\n`,
        });
        return;
      }
      if (
        body.method === 'download.workspace' ||
        body.method === 'download.env' ||
        body.method === 'download.config' ||
        body.method === 'download.claude'
      ) {
        const params = body.params as DownloadRpcParams | undefined;
        const kind = (body.method.split('.')[1] ?? 'workspace') as DownloadKind;
        const verdict = await askPrompt(prompts, subscribers, reg.boxId, {
          kind: 'confirm',
          message: `Allow download (${kind}) from ${reg.name}?`,
          detail: params?.hostPath ?? '(default host location)',
          defaultAnswer: 'n',
          context: {
            command: body.method,
            argv: params?.hostPath ? [params.hostPath] : [],
          },
        });
        if (verdict.answer !== 'y') {
          send(res, 500, { exitCode: 10, stdout: '', stderr: 'denied by user\n' });
          return;
        }
        const result = await handleDownloadRpc(reg, kind);
        const status = result.exitCode === 0 ? 200 : 500;
        send(res, status, result);
        return;
      }
      if (body.method === 'checkpoint.create') {
        const result = await handleCheckpointRpc(
          reg,
          body.params as CheckpointRpcParams | undefined,
        );
        const status = result.exitCode === 0 ? 200 : 500;
        send(res, status, result);
        return;
      }
      if (body.method === 'browser.open') {
        const params = body.params as BrowserOpenRpcParams | undefined;
        const url = typeof params?.url === 'string' ? params.url.trim() : '';
        if (!isOpenableUrl(url)) {
          // The scheme guard keeps a box from handing the host's `open` a
          // file path or app instead of a URL.
          send(res, 400, {
            exitCode: 64,
            stdout: '',
            stderr: 'browser.open: only http/https URLs are allowed\n',
          });
          return;
        }
        // The box already opened the link in its own browser; this RPC is
        // just a notification. Record the event and answer at once — never
        // block the box on the host user's decision.
        await store.appendEvent({ boxId: reg.boxId, type: 'browser-open', payload: { url } });
        send(res, 200, { exitCode: 0, stdout: '', stderr: '' });
        // Offer to mirror the link to the host browser: a non-blocking,
        // auto-expiring confirm prompt in the footer/dashboard. Skipped under
        // AGENTBOX_PROMPT=off so a headless box can't spray the host with
        // browser tabs via askPrompt's auto-'y'.
        if (process.env.AGENTBOX_PROMPT !== 'off') {
          if (mode === 'box' && hostActions) {
            // Cloud: the in-sandbox relay has no SSE subscribers (the host
            // wrapper attaches to the host relay, not the in-sandbox one).
            // Queue a `browser.open.mirror` host action — the host poller
            // drains it, executes the prompt + open against host
            // subscribers, and resolves the parked entry. We don't await;
            // the host's verdict isn't reported back to the in-box agent
            // and `HostActionQueue.maxAgeMs` GCs the entry if it lingers.
            void hostActions.enqueue(reg.boxId, 'browser.open.mirror', { url });
          } else {
            void askPrompt(
              prompts,
              subscribers,
              reg.boxId,
              {
                kind: 'confirm',
                message: `Open link from box ${reg.name} on the host?`,
                detail: url,
                defaultAnswer: 'n',
                context: { command: 'browser.open', argv: [url] },
              },
              { ttlMs: BROWSER_OPEN_PROMPT_TTL_MS },
            )
              .then((verdict) => {
                if (verdict.answer === 'y' && !verdict.cancelled) {
                  void runHostCommand([hostOpenCommand(), url], BROWSER_OPEN_RPC_TIMEOUT_MS);
                }
              })
              .catch(() => {
                /* best-effort */
              });
          }
        }
        return;
      }
      await store.appendEvent({
        boxId: reg.boxId,
        type: 'rpc-unknown',
        payload: { method: body.method },
      });
      send(res, 501, { error: 'rpc method not implemented', method: body.method });
      return;
    }

    if (route === 'POST /admin/register-box') {
      const body = await readJsonBody<RegisterBoxBody>(req);
      if (
        !body ||
        typeof body.boxId !== 'string' ||
        typeof body.token !== 'string' ||
        typeof body.name !== 'string' ||
        body.boxId.length === 0 ||
        body.token.length === 0
      ) {
        send(res, 400, { error: 'expected {boxId, token, name}' });
        return;
      }
      const worktrees = sanitizeWorktrees(body.worktrees);
      // Only accept a finite positive integer; everything else (including the
      // common `undefined` from legacy boxes) drops to `undefined` and the
      // status-store falls back to the `<id>-<mnemonic>` segment shape.
      const projectIndex =
        typeof body.projectIndex === 'number' &&
        Number.isFinite(body.projectIndex) &&
        body.projectIndex > 0
          ? Math.trunc(body.projectIndex)
          : undefined;
      const kind = body.kind === 'cloud' ? 'cloud' : 'docker';
      const reg: BoxRegistration = {
        boxId: body.boxId,
        token: body.token,
        name: body.name,
        kind,
        backend:
          typeof body.backend === 'string' && body.backend.length > 0
            ? body.backend
            : undefined,
        registeredAt: new Date().toISOString(),
        containerName:
          typeof body.containerName === 'string' && body.containerName.length > 0
            ? body.containerName
            : undefined,
        createdAt:
          typeof body.createdAt === 'string' && body.createdAt.length > 0
            ? body.createdAt
            : undefined,
        projectIndex,
        worktrees,
        previewUrl:
          typeof body.previewUrl === 'string' && body.previewUrl.length > 0
            ? body.previewUrl
            : undefined,
        previewToken:
          typeof body.previewToken === 'string' && body.previewToken.length > 0
            ? body.previewToken
            : undefined,
        bridgeToken:
          typeof body.bridgeToken === 'string' && body.bridgeToken.length > 0
            ? body.bridgeToken
            : undefined,
        autoApproveHostActions: body.autoApproveHostActions === true,
      };
      await store.registerBox(reg);
      log(
        `registered ${kind} box ${reg.boxId} (${reg.name})` +
          (worktrees && worktrees.length > 0 ? ` with ${String(worktrees.length)} worktree(s)` : ''),
      );
      // Cloud boxes get a host-side poller so the host relay can mirror their
      // status into its BoxStatusStore (and, once the executor is wired,
      // drain queued host-only RPCs and post results back).
      if (kind === 'cloud' && reg.previewUrl && reg.bridgeToken) {
        try {
          const set = await getPollers();
          set.start(reg.boxId, {
            boxId: reg.boxId,
            previewUrl: reg.previewUrl,
            bridgeToken: reg.bridgeToken,
            previewToken: reg.previewToken,
            onEvents: async (evs) => {
              for (const ev of evs) {
                await store.appendEvent({
                  boxId: reg.boxId,
                  type: ev.type,
                  payload: ev.payload,
                  ts: ev.ts,
                });
              }
            },
            onStatus: (status) => {
              if (isValidBoxStatus(status)) {
                void store.setStatus(reg.boxId, reg.name, reg.projectIndex, status);
              }
            },
            // Drained host-only RPCs (git.push, …) run on the host via the
            // executor and the result is POSTed back to /bridge/action-result.
            // No backend name → no executor; the poller's default respond
            // already returns a "no executor" error so the box unblocks.
            onAction: reg.backend
              ? async (action, respond) => {
                  try {
                    const result = await executeCloudAction(action, {
                      backendName: reg.backend!,
                      boxId: reg.boxId,
                      boxName: reg.name,
                      prompts,
                      subscribers,
                      hostInitiatedTokens,
                      log,
                    });
                    await respond(result);
                  } catch (err) {
                    await respond({
                      exitCode: 1,
                      stdout: '',
                      stderr: `host executor failed: ${err instanceof Error ? err.message : String(err)}\n`,
                    });
                  }
                }
              : undefined,
            // Self-heal a dead preview transport (hetzner SSH `-L` after a
            // ControlMaster death). The relay strips the `cloud:` prefix
            // the cloud-provider tags onto BoxRecord.container — what the
            // backend's `get(sandboxId)` expects is the bare sandbox id.
            recoverPreviewUrl: reg.backend
              ? async () => refreshCloudPreviewUrl(reg.backend!, reg.boxId, DEFAULT_BOX_RELAY_PORT)
              : undefined,
            logger: log,
          });
        } catch (err) {
          log(
            `failed to start cloud poller for ${reg.boxId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      send(res, 204, null);
      return;
    }

    if (route === 'POST /admin/forget-box') {
      const body = await readJsonBody<{ boxId?: string }>(req);
      if (!body || typeof body.boxId !== 'string' || body.boxId.length === 0) {
        send(res, 400, { error: 'expected {boxId}' });
        return;
      }
      const existed = await store.forgetBox(body.boxId);
      await store.deleteStatus(body.boxId);
      if (pollers) await pollers.stop(body.boxId);
      log(`forgot box ${body.boxId} (existed=${String(existed)})`);
      send(res, 204, null);
      return;
    }

    if (route === 'GET /admin/box-status') {
      const box = url.searchParams.get('box') ?? '';
      const status = box ? await store.getStatus(box) : undefined;
      if (!status) {
        send(res, 404, { error: 'no status for box', box });
        return;
      }
      send(res, 200, status);
      return;
    }

    if (route === 'GET /admin/events') {
      const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0;
      const box = url.searchParams.get('box') ?? undefined;
      const list = await store.listEvents(since, box ?? undefined);
      send(res, 200, { events: list });
      return;
    }

    if (route === 'GET /admin/registry') {
      // Redact tokens; callers on the admin path don't need them and we don't
      // want them showing up in logs if someone curls this.
      const redacted = (await store.listBoxes()).map((r) => ({
        boxId: r.boxId,
        name: r.name,
        registeredAt: r.registeredAt,
        containerName: r.containerName,
        createdAt: r.createdAt,
        projectIndex: r.projectIndex,
        worktrees: r.worktrees ?? [],
      }));
      send(res, 200, { boxes: redacted });
      return;
    }

    if (route === 'GET /admin/prompts') {
      // One-shot snapshot of pending host-action approvals for a box. The SSE
      // `/stream` variant is for long-lived wrappers; this is for an
      // orchestrator (or `agentbox agent approvals`) that wants to inspect the
      // backlog, answer via /admin/prompts/answer, and move on without holding
      // a stream open. `boxId=` required, same as /stream.
      const boxId = url.searchParams.get('boxId') ?? '';
      if (boxId.length === 0) {
        send(res, 400, { error: 'missing boxId query param' });
        return;
      }
      send(res, 200, { prompts: prompts.forBox(boxId) });
      return;
    }

    if (route === 'GET /admin/prompts/stream') {
      // Per-box SSE channel. The wrapper (apps/cli/src/wrapped-pty) subscribes
      // and stays connected; we push prompt-ask events on broadcast and a
      // periodic ping so the wrapper can detect a dead socket without traffic.
      // `boxId=` is required so a host with multiple boxes only sees its own
      // box's prompts (the wrapper attaches per-box anyway).
      const boxId = url.searchParams.get('boxId') ?? '';
      if (boxId.length === 0) {
        send(res, 400, { error: 'missing boxId query param' });
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      // Helps with proxies (e.g. nginx) that would otherwise buffer the
      // chunked response. The relay binds to loopback so this is belt-and-
      // suspenders, but the cost is one extra header.
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      res.write(': connected\n\n');
      subscribers.add(boxId, res);
      // Flush any prompts that arrived while no wrapper was attached — per
      // the design we block indefinitely on the in-box RPC, so a backlog can
      // build up between detach and reattach.
      for (const ev of prompts.forBox(boxId)) {
        res.write(`event: prompt-ask\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      // Then any active notices, so a wrapper attaching mid-checkpoint still
      // sees the in-progress warning (prompts first — they outrank notices).
      for (const ev of notices.forBox(boxId)) {
        res.write(`event: notice-set\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      const heartbeat = setInterval(() => {
        try {
          res.write(`event: ping\ndata: {"ts":"${new Date().toISOString()}"}\n\n`);
        } catch {
          /* dead socket; close handler below removes */
        }
      }, SSE_HEARTBEAT_MS);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
      res.on('close', () => {
        clearInterval(heartbeat);
        subscribers.remove(boxId, res);
      });
      return;
    }

    if (route === 'POST /admin/prompts/answer') {
      const body = await readJsonBody<PromptAnswerBody>(req);
      if (!isPromptAnswerBody(body)) {
        send(res, 400, { error: 'expected {id, answer:"y"|"n", cancelled?}' });
        return;
      }
      // Find which box this id belongs to before resolving, so we can target
      // the prompt-resolved broadcast (other wrappers on the same box clear
      // their stale footer).
      const targetBox = prompts.boxFor(body.id);
      const hit = prompts.resolve(body.id, body.answer, body.cancelled);
      if (!hit) {
        // Already answered (idempotent) or never existed.
        send(res, 404, { error: 'no pending prompt with that id' });
        return;
      }
      if (targetBox) {
        subscribers.broadcast(targetBox, 'prompt-resolved', { id: body.id });
      }
      send(res, 204, null);
      return;
    }

    if (route === 'POST /admin/host-initiated/mint') {
      // Host CLI mints a one-time token before invoking `agentbox-ctl` in a
      // box for a credentialed RPC. The token is scoped to
      // (boxId, method, paramsHash) and consumed on first use.
      // See ./host-initiated.ts for rationale.
      //
      // paramsHash is mandatory in practice — without it a box that
      // harvests the token from agentbox-ctl's /proc/<pid>/cmdline could
      // replay it with mutated args. Accept `null` only for callers that
      // intentionally opt out (none today).
      const body = await readJsonBody<{
        boxId?: string;
        method?: string;
        paramsHash?: string | null;
        ttlMs?: number;
      }>(req);
      if (
        !body ||
        typeof body.boxId !== 'string' ||
        body.boxId.length === 0 ||
        typeof body.method !== 'string' ||
        body.method.length === 0
      ) {
        send(res, 400, { error: 'expected {boxId, method, paramsHash, ttlMs?}' });
        return;
      }
      // Allow `paramsHash: null` (explicit opt-out) or a hex string.
      let paramsHash: string | null;
      if (body.paramsHash === null || body.paramsHash === undefined) {
        paramsHash = null;
      } else if (typeof body.paramsHash === 'string' && /^[0-9a-f]{64}$/.test(body.paramsHash)) {
        paramsHash = body.paramsHash;
      } else {
        send(res, 400, { error: 'paramsHash must be a 64-hex sha256 string or null' });
        return;
      }
      const ttlMs =
        typeof body.ttlMs === 'number' && Number.isFinite(body.ttlMs) && body.ttlMs > 0
          ? body.ttlMs
          : undefined;
      const token = hostInitiatedTokens.mint(body.boxId, body.method, paramsHash, ttlMs);
      log(`host-initiated-mint box=${body.boxId} method=${body.method} paramsBound=${paramsHash !== null}`);
      send(res, 200, { token });
      return;
    }

    if (route === 'POST /admin/notices/set') {
      const body = await readJsonBody<SetNoticeBody>(req);
      if (
        !body ||
        typeof body.boxId !== 'string' ||
        body.boxId.length === 0 ||
        typeof body.kind !== 'string' ||
        body.kind.length === 0 ||
        typeof body.message !== 'string' ||
        body.message.length === 0
      ) {
        send(res, 400, { error: 'expected {boxId, kind, message}' });
        return;
      }
      const ttlMs =
        typeof body.ttlMs === 'number' && Number.isFinite(body.ttlMs) && body.ttlMs > 0
          ? body.ttlMs
          : undefined;
      const id = notices.set(body.boxId, body.kind, body.message, ttlMs);
      log(`notice-set box=${body.boxId} kind=${body.kind} id=${id}`);
      send(res, 200, { id });
      return;
    }

    if (route === 'POST /admin/queue/enqueue') {
      // The CLI's `submitQueueJob` writes the manifest first, then POSTs here
      // so the relay's scheduler runs immediately instead of waiting for the
      // next periodic tick. Body is informational — the source of truth is
      // the manifest on disk.
      const body = await readJsonBody<{ id?: string }>(req);
      if (!body || typeof body.id !== 'string' || body.id.length === 0) {
        send(res, 400, { error: 'expected {id}' });
        return;
      }
      log(`queue-enqueue id=${body.id}`);
      queuePoke?.();
      send(res, 204, null);
      return;
    }

    if (route === 'POST /admin/notices/clear') {
      const body = await readJsonBody<ClearNoticeBody>(req);
      if (!body || typeof body.id !== 'string' || body.id.length === 0) {
        send(res, 400, { error: 'expected {boxId, id}' });
        return;
      }
      notices.clear(body.id);
      log(`notice-clear id=${body.id}`);
      send(res, 204, null);
      return;
    }

    send(res, 404, { error: 'not found', route });
  }

  async function authBox(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<BoxRegistration | null> {
    const token = bearerToken(req);
    if (token.length === 0) {
      send(res, 401, { error: 'missing bearer token' });
      return null;
    }
    const match = await store.authenticateBox(token);
    if (!match) {
      send(res, 401, { error: 'unknown box token' });
      return null;
    }
    return match;
  }

  return {
    server,
    store,
    registry,
    events,
    statusStore,
    prompts,
    subscribers,
    notices,
    hostActions: hostActions ?? undefined,
    url: `http://${host}:${String(opts.port)}`,
    setQueuePoke: (fn) => {
      queuePoke = fn;
    },
    close: async () => {
      if (pollers) await pollers.stopAll();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}


function sanitizeWorktrees(input: BoxWorktree[] | undefined): BoxWorktree[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: BoxWorktree[] = [];
  for (const w of input) {
    if (
      w &&
      typeof w.containerPath === 'string' &&
      typeof w.hostMainRepo === 'string' &&
      typeof w.branch === 'string'
    ) {
      out.push({
        containerPath: w.containerPath,
        hostMainRepo: w.hostMainRepo,
        branch: w.branch,
      });
    }
  }
  return out;
}

/**
 * Resolve `params.path` (a path inside the container) to the registered
 * worktree whose hostMainRepo + branch the relay should run git in.
 * `/workspace` maps to the root repo; `/workspace/<sub>` maps to the nested
 * repo when one is registered (longest prefix wins).
 */
function resolveWorktree(reg: BoxRegistration, containerPath: string): BoxWorktree | null {
  const trees = reg.worktrees ?? [];
  if (trees.length === 0) return null;
  const exact = trees.find((w) => w.containerPath === containerPath);
  if (exact) return exact;
  const prefixMatches = trees
    .filter((w) => containerPath === w.containerPath || containerPath.startsWith(w.containerPath + '/'))
    .sort((a, b) => b.containerPath.length - a.containerPath.length);
  return prefixMatches[0] ?? trees.find((w) => w.containerPath === '/workspace') ?? null;
}

/**
 * git.push / git.fetch: run `git -C <hostMainRepo> <op> <remote> <branch>
 * [args]` on the host with the user's creds. The in-container worktree's
 * working tree isn't on the host, so we operate on the shared `.git/` from
 * the main repo dir — refs already point at the in-container commits
 * (committed there against the bind-mounted .git).
 *
 * git.pull is intentionally NOT handled here: a pull merges into the
 * working tree, which lives inside the container. The in-box
 * `agentbox-ctl git pull` calls git.fetch via RPC, then runs a local merge.
 */
async function handleGitRpc(
  reg: BoxRegistration,
  method: 'git.push' | 'git.fetch',
  params: GitRpcParams | undefined,
): Promise<GitRpcResult> {
  const containerPath = params?.path ?? '/workspace';
  const worktree = resolveWorktree(reg, containerPath);
  if (!worktree) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: `no worktree registered for box ${reg.boxId} matching ${containerPath}`,
    };
  }
  const op = method === 'git.push' ? 'push' : 'fetch';
  const remote = params?.remote ?? 'origin';
  const argv = ['git', '-C', worktree.hostMainRepo, op, remote, worktree.branch];
  if (Array.isArray(params?.args)) {
    for (const a of params.args) {
      if (typeof a === 'string') argv.push(a);
    }
  }
  const result = await runHostCommand(argv);
  // After a successful push, mirror what `git push -u` would have left behind:
  // make the branch track `origin/<branch>` so the in-box `git status` /
  // Claude Code's PR badge see an upstream. Skip per-box scratch branches
  // (`agentbox/<name>`) — they're local-only by design. Docker shares .git/
  // with the box, so update-ref of the remote-tracking ref already happened
  // during the push; only the upstream config is missing.
  if (method === 'git.push' && result.exitCode === 0 && !worktree.branch.startsWith('agentbox/')) {
    await runHostCommand([
      'git',
      '-C',
      worktree.hostMainRepo,
      'branch',
      `--set-upstream-to=${remote}/${worktree.branch}`,
      worktree.branch,
    ]);
  }
  return result;
}

/**
 * gh.pr.<op>: shell to the host's `gh` CLI (with the user's gh auth) to drive
 * a PR operation requested from inside the box. Read-only ops (`view`,
 * `list`) bypass the confirm prompt; everything else surfaces an
 * `askPrompt` to the host wrapper before running. `merge` and `checkout`
 * have additional opt-in env guards — see `refuseMergeBypass` and
 * `refuseCheckoutByDefault` in `./gh.ts`.
 *
 * Runs `gh` with `cwd = worktree.hostMainRepo` so `gh` infers the repo from
 * the host repo's `git remote -v`. The box's worktree branch is registered
 * (used to refuse `checkout` against the active per-box branch).
 */
async function handleGhPrRpc(
  op: GhPrOp,
  reg: BoxRegistration,
  params: GhPrRpcParams | undefined,
  prompts: PendingPrompts,
  subscribers: PromptSubscribers,
  hostInitiatedTokens: HostInitiatedTokens,
): Promise<GitRpcResult> {
  // Env-only refusals first — cheap, deterministic, no fs/process calls.
  const mergeBypass = refuseMergeBypass(op);
  if (mergeBypass) return mergeBypass;
  const checkoutOptIn = refuseCheckoutByDefault(op);
  if (checkoutOptIn) return checkoutOptIn;

  const containerPath = params?.path ?? '/workspace';
  const worktree = resolveWorktree(reg, containerPath);
  if (!worktree) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: `no worktree registered for box ${reg.boxId} matching ${containerPath}`,
    };
  }
  const ghReady = await assertGhReady();
  if (ghReady) return ghReady;

  const args = Array.isArray(params?.args)
    ? params.args.filter((a): a is string => typeof a === 'string')
    : [];

  if (op === 'checkout') {
    const branches = (reg.worktrees ?? []).map((w) => w.branch);
    const guard = await checkoutGuards(worktree.hostMainRepo, branches);
    if (guard) return guard;
  }

  // Host-initiated `gh pr <op>` (from `agentbox git pr <op> <box>`) skips
  // the confirm prompt — but only with a valid scope-matched, params-hash-
  // bound one-time token. If a token is *present* but invalid (mutated
  // params, replayed, etc.) we reject hard — that's an attack signal. Only
  // fall through to the prompt when no token was claimed. The
  // `refuseMergeBypass` / `refuseCheckoutByDefault` guards above still run.
  const tokenClaimedGh = typeof params?.hostInitiated === 'string';
  const incomingHashGh = hashRpcParams(params);
  const hostInitiatedOk =
    !GH_PR_READ_ONLY_OPS.has(op) &&
    tokenClaimedGh &&
    hostInitiatedTokens.consume(params?.hostInitiated, reg.boxId, `gh.pr.${op}`, incomingHashGh);
  if (!GH_PR_READ_ONLY_OPS.has(op) && tokenClaimedGh && !hostInitiatedOk) {
    return {
      exitCode: 10,
      stdout: '',
      stderr:
        'host-initiated token rejected: invalid, expired, or bound to different params\n',
    };
  }
  if (!GH_PR_READ_ONLY_OPS.has(op) && !hostInitiatedOk) {
    const detail = args.join(' ').slice(0, 200);
    const verdict = await askPrompt(prompts, subscribers, reg.boxId, {
      kind: 'confirm',
      message: `Allow gh pr ${op} from box ${reg.name}?`,
      detail,
      defaultAnswer: 'n',
      context: {
        command: `gh pr ${op}`,
        cwd: containerPath,
        argv: args,
      },
    });
    if (verdict.answer !== 'y') {
      return { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
    }
  }

  // Default `--head` to the box's branch for `create` (the host repo cwd isn't
  // on the box branch, so gh can't infer it). Done after token validation —
  // which hashes the incoming `params`, not this post-injection argv.
  const finalArgs = injectPrCreateHead(op, worktree.branch, args);
  // Never let `gh` fall back to the host repo's checked-out branch.
  if (prCreateNeedsHead(op, finalArgs)) return PR_CREATE_NO_HEAD_REFUSAL;
  return runHostGh(['pr', op, ...finalArgs], worktree.hostMainRepo);
}

/**
 * `gh.run.<op>` (list / view / rerun). Runs `gh run …` in the host main repo
 * so gh infers the GitHub repo from its remotes. `list` / `view` are read-only;
 * `rerun` re-triggers CI and goes through the host confirm prompt. No
 * host-initiated token path — this is an in-box-only surface.
 */
async function handleGhRunRpc(
  op: GhRunOp,
  reg: BoxRegistration,
  params: GhRunRpcParams | undefined,
  prompts: PendingPrompts,
  subscribers: PromptSubscribers,
): Promise<GitRpcResult> {
  const containerPath = params?.path ?? '/workspace';
  const worktree = resolveWorktree(reg, containerPath);
  if (!worktree) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: `no worktree registered for box ${reg.boxId} matching ${containerPath}`,
    };
  }
  const ghReady = await assertGhReady();
  if (ghReady) return ghReady;

  const args = Array.isArray(params?.args)
    ? params.args.filter((a): a is string => typeof a === 'string')
    : [];

  if (!GH_RUN_READ_ONLY_OPS.has(op)) {
    const detail = args.join(' ').slice(0, 200);
    const verdict = await askPrompt(prompts, subscribers, reg.boxId, {
      kind: 'confirm',
      message: `Allow gh run ${op} from box ${reg.name}?`,
      detail,
      defaultAnswer: 'n',
      context: { command: `gh run ${op}`, cwd: containerPath, argv: args },
    });
    if (verdict.answer !== 'y') {
      return { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
    }
  }
  return runHostGh(['run', op, ...args], worktree.hostMainRepo);
}

/**
 * `gh.api`: allowlisted REST calls. Runs `gh api <endpoint> …` in the host main
 * repo. The endpoint must match `GH_API_ALLOWED_ENDPOINTS`; `refuseGhApiCall`
 * then enforces the method policy (GET anywhere on the allowlist, POST only on
 * the comment endpoints). No prompt — reads and comment POSTs are both silent.
 */
async function handleGhApiRpc(
  reg: BoxRegistration,
  params: GhApiRpcParams | undefined,
): Promise<GitRpcResult> {
  const containerPath = params?.path ?? '/workspace';
  const worktree = resolveWorktree(reg, containerPath);
  if (!worktree) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: `no worktree registered for box ${reg.boxId} matching ${containerPath}`,
    };
  }
  const endpoint = typeof params?.endpoint === 'string' ? params.endpoint : '';
  if (!isAllowedGhApiEndpoint(endpoint)) return GH_API_ENDPOINT_REFUSAL;
  const args = Array.isArray(params?.args)
    ? params.args.filter((a): a is string => typeof a === 'string')
    : [];
  const callRefusal = refuseGhApiCall(endpoint, args);
  if (callRefusal) return callRefusal;
  const ghReady = await assertGhReady();
  if (ghReady) return ghReady;
  return runHostGh(['api', endpoint, ...args], worktree.hostMainRepo);
}

/**
 * `integration.<service>.<op>`: generic dispatch for any connector
 * registered in `@agentbox/integrations`. Mirrors the `gh.pr.<op>` flow
 * (worktree resolve → `assertReady` → host-initiated token / askPrompt for
 * writes → shell out). Reads bypass the prompt; writes are always gated.
 * Op-level `refuseCall` (e.g. `notion.api`'s GET-only check) runs after
 * worktree resolve but before any host process is touched.
 *
 * All failures return the same `{exitCode, stdout, stderr}` envelope as
 * `handleGhPrRpc` — including unknown-method/service shapes (exit 64) —
 * so the cloud and docker paths emit identical wire shapes per the
 * "fix across all providers" rule.
 */
async function handleIntegrationRpc(
  method: string,
  reg: BoxRegistration,
  params: IntegrationRpcParams | undefined,
  prompts: PendingPrompts,
  subscribers: PromptSubscribers,
  hostInitiatedTokens: HostInitiatedTokens,
): Promise<GitRpcResult> {
  const parsed = parseIntegrationMethod(method);
  if (!parsed) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: `unknown integration method shape: ${method}\n`,
    };
  }
  const connector = getConnector(parsed.service);
  if (!connector) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: `unknown integration service: ${parsed.service}\n`,
    };
  }
  const opDesc = connector.ops[parsed.op];
  if (!opDesc) {
    return makeIntegrationOpRefusal(
      parsed.service,
      parsed.op,
      connector.hostBin,
      Object.keys(connector.ops),
    );
  }
  const containerPath = params?.path ?? '/workspace';
  const worktree = resolveWorktree(reg, containerPath);
  if (!worktree) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: `no worktree registered for box ${reg.boxId} matching ${containerPath}`,
    };
  }
  const args = Array.isArray(params?.args)
    ? params.args.filter((a): a is string => typeof a === 'string')
    : [];

  const callRefusal = refuseIntegrationCall(opDesc, args);
  if (callRefusal) return callRefusal;

  // Layered enablement gate — the in-box shim and ctl both transparently
  // forward to here, so this one check covers every caller. Reads the
  // worktree's project config so a single project can opt in without
  // flipping it globally. Placed after `refuseIntegrationCall` so the
  // ordering matches the cloud handler (`runIntegrationRpc` in
  // host-actions.ts) — keeps the wire envelope identical across providers
  // for the malformed-args-to-disabled-integration edge case. Runs before
  // `assertIntegrationReady`, the prompt, and the host spawn so a disabled
  // integration is never user-visible as a permission prompt.
  const enableRefusal = await refuseIfIntegrationDisabled(
    parsed.service,
    worktree.hostMainRepo,
  );
  if (enableRefusal) return enableRefusal;

  const ready = await assertIntegrationReady(connector);
  if (ready) return ready;

  // Host-initiated calls (from a host CLI mint) skip the prompt — but only
  // with a valid scope-matched, params-hash-bound one-time token. Hard
  // reject a *present-but-invalid* token (attack signal). Only fall through
  // to the prompt when no token was claimed. Reads never need a token.
  if (opDesc.write) {
    const tokenClaimed = typeof params?.hostInitiated === 'string';
    const incomingHash = hashRpcParams(params);
    const tokenOk =
      tokenClaimed &&
      hostInitiatedTokens.consume(params?.hostInitiated, reg.boxId, method, incomingHash);
    if (tokenClaimed && !tokenOk) {
      return {
        exitCode: 10,
        stdout: '',
        stderr:
          'host-initiated token rejected: invalid, expired, or bound to different params\n',
      };
    }
    if (!tokenOk) {
      const detail = args.join(' ').slice(0, 200);
      const verdict = await askPrompt(prompts, subscribers, reg.boxId, {
        kind: 'confirm',
        message: `Allow ${parsed.service} ${parsed.op} from box ${reg.name}?`,
        detail,
        defaultAnswer: 'n',
        context: {
          command: `integration ${parsed.service} ${parsed.op}`,
          cwd: containerPath,
          argv: args,
        },
      });
      if (verdict.answer !== 'y') {
        return { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
      }
    }
  }

  return runHostIntegration(connector, opDesc, args, worktree.hostMainRepo);
}

/**
 * cp.toHost / cp.fromHost: copy a file/dir between box and host. Shells
 * out to the installed agentbox CLI's `cp` subcommand — that command
 * already knows how to handle the docker exec tar pipe + chown + auto-
 * unpause; duplicating that here would drift. `AGENTBOX_CLI_ENTRY` is set
 * by `ensureRelay` when it spawns this process.
 *
 * Caller (the /rpc route) already gated this with askPrompt and rejected
 * non-'y' answers; we never reach this code without consent.
 */
async function handleCpRpc(
  reg: BoxRegistration,
  method: 'cp.toHost' | 'cp.fromHost',
  params: CpRpcParams,
): Promise<GitRpcResult> {
  const entry = process.env.AGENTBOX_CLI_ENTRY;
  if (!entry) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: 'relay: AGENTBOX_CLI_ENTRY not set; cannot run cp host-side',
    };
  }
  // `agentbox cp` is positional: <src> [dst]. Direction is encoded by which
  // arg carries the `<boxName>:` prefix.
  const boxRef = `${reg.name}:${params.boxPath}`;
  const flags: string[] = [];
  for (const pat of params.exclude ?? []) flags.push('--exclude', pat);
  if (params.defaultExcludes === false) flags.push('--no-default-excludes');
  if (params.yes) flags.push('--yes');
  const argv =
    method === 'cp.toHost'
      ? [process.execPath, entry, 'cp', boxRef, params.hostPath, ...flags]
      : [process.execPath, entry, 'cp', params.hostPath, boxRef, ...flags];
  return runHostCommand(argv, CP_RPC_TIMEOUT_MS);
}

/**
 * download.{workspace,env,config,claude}: ask the installed agentbox CLI
 * to pull box contents to the host. Same decoupling rationale as cp — the
 * CLI owns rsync exclude lists, gitignore handling, claude registry
 * merging. The relay passes `-y` so the host CLI doesn't try to prompt
 * (we already did, via the host wrapper, before reaching this handler).
 */
async function handleDownloadRpc(
  reg: BoxRegistration,
  kind: DownloadKind,
): Promise<GitRpcResult> {
  // params.hostPath is reserved in the wire shape; the v1 relay ignores it
  // and lets the host CLI use its defaults (box.workspacePath or ~/.claude).
  const entry = process.env.AGENTBOX_CLI_ENTRY;
  if (!entry) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: 'relay: AGENTBOX_CLI_ENTRY not set; cannot run download host-side',
    };
  }
  const argv = [process.execPath, entry, 'download'];
  // `workspace` is the default download (no subcommand); the other three
  // are subcommands of `download`.
  if (kind !== 'workspace') argv.push(kind);
  argv.push(reg.name, '-y');
  return runHostCommand(argv, DOWNLOAD_RPC_TIMEOUT_MS);
}

/**
 * Capture a checkpoint host-side by shelling out to the installed agentbox
 * CLI (same decoupling philosophy as `handleGitRpc` spawning `git`). The
 * relay only knows the box id; the CLI resolves the BoxRecord (project root,
 * checkpoint config, snapshot storage) from it. `AGENTBOX_CLI_ENTRY` is set
 * by `ensureRelay` when it spawns this process.
 */
async function handleCheckpointRpc(
  reg: BoxRegistration,
  params: CheckpointRpcParams | undefined,
): Promise<GitRpcResult> {
  const entry = process.env.AGENTBOX_CLI_ENTRY;
  if (!entry) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: 'relay: AGENTBOX_CLI_ENTRY not set; cannot run checkpoint host-side',
    };
  }
  const argv = [process.execPath, entry, 'checkpoint', 'create', reg.boxId];
  if (params?.name) argv.push('--name', params.name);
  if (params?.merged === true) argv.push('--merged');
  if (params?.setDefault === true) argv.push('--set-default');
  if (params?.replace === true) argv.push('--replace');
  return runHostCommand(argv, CHECKPOINT_RPC_TIMEOUT_MS);
}

/**
 * Guard for the `browser.open` RPC: only absolute http/https URLs may be
 * handed to the host's `open`. Rejecting every other scheme (`file:`,
 * `javascript:`, bare paths) keeps an in-box agent from opening host files
 * or apps under the guise of "opening a link".
 */
export function isOpenableUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function runHostCommand(
  argv: string[],
  timeoutMs: number = GIT_RPC_TIMEOUT_MS,
): Promise<GitRpcResult> {
  return new Promise<GitRpcResult>((resolve) => {
    const [cmd, ...rest] = argv;
    if (!cmd) {
      resolve({ exitCode: 64, stdout: '', stderr: 'empty command' });
      return;
    }
    const child = spawn(cmd, rest, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      stderr += `\nrelay: command timed out after ${String(timeoutMs)}ms\n`;
      finish(124);
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      stderr += String(err.message ?? err);
      finish(127);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code ?? -1);
    });
  });
}

export async function startRelayServer(opts: RelayServerOptions): Promise<RelayServerHandle> {
  const handle = createRelayServer(opts);
  await new Promise<void>((resolve, reject) => {
    handle.server.once('error', reject);
    handle.server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      handle.server.removeListener('error', reject);
      resolve();
    });
  });
  return handle;
}

export type { BoxRegistration, RelayEvent };
