import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  boxCarriedHostPaths,
  boxWorkspacePath,
  executeCloudAction,
  refreshCloudPreviewUrl,
  resolveHostPath,
} from './host-actions.js';
import { canAutoApproveTransfer } from './safe-transfer.js';
import { HostActionQueue } from './host-action-queue.js';
import { HostReachQueue, type HostReachUnreachable } from './host-reach.js';
import { cpCachePrefix } from './cp-cache.js';
import { describeCpCacheEntries, lookupCpCache, serveCpFromCache } from './cp-cache-serve.js';
import { cpOutboxPrefix, listCpOutbox, parkCpOutbox, removeCpOutboxItem } from './cp-outbox.js';
import { HubNotifier } from './hub-notifier.js';
import { BoxNotices } from './notices.js';
import { hostOpenCommand, projectSlugFromOriginUrl } from '@agentbox/sandbox-core';
import {
  isSanctionedPushBranch,
  isScratchBranch,
  landRefspec,
  parseDownloadKind,
  resolveLandDest,
  resolveRemote,
  sanitizeGitArgs,
  upstreamRef,
} from '@agentbox/core';
import {
  checkoutGuards,
  ghDestructiveTarget,
  ghRunContext,
  ghVerbArgv,
  injectPrCreateHead,
  PR_CREATE_NO_HEAD_REFUSAL,
  prCreateNeedsHead,
  refuseBlockedGhCall,
  refuseCheckoutByDefault,
  refuseGhApiInput,
  resolveGhTarget,
  runHostGh,
  type GhExecRpcParams,
} from './gh.js';
import { hashRpcParams, HostInitiatedTokens } from './host-initiated.js';
import { GitHubAppLeaser, loadGitHubAppConfig, type GitHubAppConfig } from './github-app.js';
import { leaseTokenResult } from './lease.js';
import { gateApproval, type GateDeps, type PromptMode } from './permission.js';
import { resolveWorktree, hostRepoUnavailableReason } from './worktree.js';
import { adminGateAllows, timingSafeEqualStr } from './admin-gate.js';
import {
  handleCustodyBlobRequest,
  handleCustodyRequest,
  isCustodyBlobPath,
} from './custody/routes.js';
import { handleRemoteBoxesRequest, isRemoteBoxesPath } from './remote-boxes.js';
import { readCreateJobLog } from './job-log-tail.js';
import { handleStoreRpcRequest, isStoreRpcPath } from './store/store-rpc-routes.js';
import type { CustodyStore } from './custody/store.js';
import {
  isValidToolName,
  loadGrantedTools,
  resolveProjectToolsFile,
  writeToolGrant,
} from '@agentbox/config';
import {
  argvIsExplicitlyAllowed,
  refuseCredentialArgv,
  refuseDeniedArgv,
  refuseIfGhDisabled,
  renderToolList,
  renderToolListJson,
  hostToolInstalled,
  resolveToolGrant,
  runGrantedTool,
  toolRequestsEnabled,
  type ToolRequestRpcParams,
} from './host-tools.js';
import { askPrompt, isPromptAnswerBody, PendingPrompts, PromptSubscribers } from './prompts.js';
import { BoxRegistry, EventBuffer } from './registry.js';
import { CREDENTIALS_UPDATED_EVENT, CredentialsFanout } from './credentials-fanout.js';
import { BoxStatusStore, isValidBoxStatus } from './status-store.js';
import { MemoryStore } from './store/memory-store.js';
import { WriteThroughStore } from './store/write-through-store.js';
import type { Store } from './store/store.js';
import { DEFAULT_BOX_RELAY_PORT } from './types.js';
import { buildCpArgv, cpFlags, normalizeCpParams, type CpMethod } from './cp-rpc.js';
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
   * Persisted-state backend. Defaults to an in-memory store wrapping the
   * relay's historical in-memory structures (the laptop relay + tests). A
   * hosted control plane injects a Postgres-backed store; a federated laptop
   * relay injects a RemoteStore. See `./store/store.ts`.
   */
  store?: Store;
  /**
   * How host-action approvals are obtained. Defaults to 'block' (the
   * long-lived laptop relay blocks on a human). The stateless hosted plane
   * uses 'poll' via its own handler, not this server. See `./permission.ts`.
   */
  promptMode?: PromptMode;
  /**
   * GitHub App config for `git.lease-token` (the hosted plane mints repo-scoped
   * installation tokens and leases them to boxes). Defaults to
   * {@link loadGitHubAppConfig} (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`).
   * Null/absent → `git.lease-token` returns a clear "not configured" error.
   */
  githubApp?: GitHubAppConfig | null;
  /**
   * Custody store (agent creds / project secrets / box SSH keys). Absent → the
   * `/admin/custody/*` routes are not served here. The control box (hetzner
   * profile) wires an {@link FsCustodyStore}. See `./custody/routes.ts`.
   */
  custody?: CustodyStore | null;
  /**
   * Per-request body cap for custody PUTs (`relay.custodyMaxBodyBytes`).
   * Defaults to 32 MiB — big enough for a project's untracked-files seed tar,
   * and scoped to custody so the 1 MiB control-plane cap still governs every
   * other route.
   */
  custodyMaxBodyBytes?: number;
  /**
   * Cap for the streaming blob surface (`relay.custodyMaxBlobBytes`). Defaults
   * to 100 MiB to match `box.cpMaxBytes`, so a `carry:` entry the CLI accepted
   * at resolve time can actually be stored — the two caps disagreeing is what
   * let an approved 25.7 MiB file be promised to the user and then dropped.
   * Enforced mid-stream, so an over-cap body is cut off rather than landed.
   */
  custodyMaxBlobBytes?: number;
  /**
   * Admin bearer that gates `/admin/custody/*` (the ONLY proof accepted — the
   * loopback bypass that covers the other `/admin/*` routes does not apply to
   * custody, since a control box behind Caddy makes every request look
   * loopback). Required for custody to serve; other admin routes are unaffected.
   */
  adminToken?: string;
  /**
   * True on a control box (the hub's password profile). Turns on the
   * `/admin/hostreach/*` surface and makes host actions that need the user's
   * own filesystem — `cp.*` — park for that machine instead of running here.
   *
   * They cannot run here: a control box's record of a box it created points at
   * the create job's temp clone, which the worker deletes, so executing locally
   * spawns the CLI with a cwd that no longer exists. Even when it does exist,
   * it is the wrong machine's files. See `docs/plans/box-cp-host-reach-plan.md`.
   */
  controlPlane?: boolean;
  /**
   * How long a parked host action waits for the user's machine before the
   * control box gives up on it (`relay.hostReachTimeoutMs`). Only meaningful
   * with `controlPlane`.
   */
  hostReachTimeoutMs?: number;
  /**
   * Optional delegate for requests that matched no relay route (e.g. Next's
   * `getRequestHandler()`). Invoked at the top-level 404 fallthrough, so every
   * relay route still matches first and the UI can never shadow `/admin`,
   * `/rpc`, etc. Lets the hub serve Next on the relay's own port.
   */
  uiHandler?: (req: IncomingMessage, res: ServerResponse) => void;
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
  /** Fan-out for the embedded hub UI's SSE route (pending-approval changes). */
  hubNotifier: HubNotifier;
  /** The custody store, when wired (control box). Used by the hub backend's reap. */
  custody?: CustodyStore | null;
  /** Present only in `mode === 'box'`: the parking lot for host-only RPCs. */
  hostActions?: HostActionQueue;
  /**
   * Present only on a control box (`controlPlane`): the parking lot for actions
   * that need the user's own machine, drained by that machine's relay over
   * `/admin/hostreach/*`.
   */
  hostReach?: HostReachQueue;
  url: string;
  /**
   * Wire a "kick the queue scheduler now" callback. Called by
   * `POST /admin/queue/enqueue` so a freshly-submitted background job doesn't
   * wait up to one tick for the relay to notice the new manifest.
   * No-op until set; the queue still picks the job up via the periodic tick.
   */
  setQueuePoke: (fn: () => void) => void;
  /**
   * Kick the queue scheduler in-process (same effect as `POST
   * /admin/queue/enqueue`, without a loopback round-trip). Used by the embedded
   * hub after it enqueues a create job via `enqueueQueueJob`. No-op until
   * `setQueuePoke` has wired the scheduler.
   */
  pokeQueue: () => void;
  /**
   * Stop the host-mode `CloudBoxPoller` for one box. The keepalive loop calls
   * this after it idle-pauses a box, because on a backend whose paused
   * sandboxes auto-resume on inbound traffic (e2b) the poller would otherwise
   * wake the box on its next long-poll. A no-op when no poller is running for
   * that box; a later `/admin/register-box` starts a fresh one.
   */
  stopCloudPoller: (boxId: string) => Promise<void>;
  close: () => Promise<void>;
}

/** Event type whose payload is a durable BoxStatus snapshot (persisted, not ringed). */
const BOX_STATUS_EVENT = 'box-status';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB hard cap; relay is for control-plane traffic, not payloads.
/**
 * Per-request cap for custody PUTs only. Custody carries project seed material
 * (an untracked-files tarball) as base64 JSON, which the 1 MiB control-plane cap
 * is far too small for — but raising {@link MAX_BODY_BYTES} would hand the same
 * budget to `/rpc` and `/events`, which have no business with payloads. Override
 * with `relay.custodyMaxBodyBytes`.
 */
const DEFAULT_CUSTODY_MAX_BODY_BYTES = 32 * 1024 * 1024; // 32 MiB
/** Matches `box.cpMaxBytes` — see the `custodyMaxBlobBytes` option doc. */
const DEFAULT_CUSTODY_MAX_BLOB_BYTES = 100 * 1024 * 1024; // 100 MiB
const GIT_RPC_TIMEOUT_MS = 120_000; // git push/pull can be slow on big repos.
const CHECKPOINT_RPC_TIMEOUT_MS = 600_000; // capturing node_modules/build trees can be slow.
const DOWNLOAD_RPC_TIMEOUT_MS = 600_000; // claude/workspace pulls over rsync can take minutes.
const CP_RPC_TIMEOUT_MS = 300_000; // single-file/dir cp; tar pipe through docker exec.
const BROWSER_OPEN_RPC_TIMEOUT_MS = 15_000; // `open` hands off to the browser and returns at once.
const BROWSER_OPEN_PROMPT_TTL_MS = 25_000; // the "open on host too?" offer auto-dismisses if ignored.
const SSE_HEARTBEAT_MS = 15_000; // every 15s; wrapper reconnects if it sees no traffic for ~30s.
/** Default hold for an idle `/admin/hostreach/poll` — under Caddy's 30s idle default. */
const DEFAULT_HOSTREACH_WAIT_MS = 25_000;
/** Ceiling for a client-requested hold, for the same proxy reason. */
const MAX_HOSTREACH_WAIT_MS = 60_000;

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

async function readRawBody(
  req: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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
    addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.')
  );
}

/**
 * Build the relay HTTP server. Routes:
 *   POST /events                — bearer auth (box token), appends to ring buffer.
 *   POST /rpc                   — bearer auth; dispatches git.push/fetch, cp.*, download.*, checkpoint.create on the host.
 *   POST /admin/register-box    — loopback only.
 *   POST /admin/forget-box      — loopback only.
 *   POST /admin/stop-poller     — loopback only; stops one box's CloudBoxPoller, keeps the registration.
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
  // Fan-out for the embedded hub UI: every change to the pending-approval set
  // pushes a refresh to browsers subscribed on the hub's SSE route. No-op when
  // no hub is attached (the CLI relay bin never subscribes).
  const hubNotifier = new HubNotifier();
  prompts.setOnChange(() => hubNotifier.notify());
  // The persisted-state seam. Defaults to a MemoryStore wrapping the concrete
  // instances above, so the laptop relay + tests behave exactly as before; a
  // hosted control plane injects a Postgres-backed store instead. Handlers go
  // through `store.*`; the concrete instances stay exposed on the handle for
  // the autopause / queue loops (bin.ts) and the unit tests that read them.
  // Persisted-state seam. localhost/tests get a MemoryStore wrapping the concrete
  // instances above (byte-identical to the pre-seam relay). A control box injects
  // a durable store (SQLite/Postgres); wrap it so every write also mirrors into
  // those instances — the daemon's loops + the hub backend read them synchronously
  // and would otherwise see an empty registry/statusStore (Backlog: phase-3
  // blocker A). `startRelayServer` hydrates the mirror from the store on boot.
  const store: Store = opts.store
    ? new WriteThroughStore(opts.store, { registry, events, statusStore })
    : new MemoryStore({ registry, events, statusStore });
  // Per-box `box.autoApproveHostActions`: when a box registered with the flag,
  // host-action confirms resolve to 'y' without a prompt, but every bypass
  // lands in the event ring buffer (visible via `/admin/events`) so it's
  // auditable. Reads the concrete registry/events synchronously (not the async
  // store): `askPrompt` broadcasts to SSE subscribers synchronously, so this
  // gate must stay sync. The MemoryStore wraps these same instances, so the
  // sync policy view and the async store view never diverge on the laptop relay.
  prompts.setAutoApprovePolicy({
    shouldAutoApprove: (boxId) => registry.get(boxId)?.autoApproveHostActions === true,
    audit: (boxId, params, reason) => {
      events.append({
        boxId,
        type: 'host-action-auto-approved',
        payload: {
          command: params.context?.command,
          argv: params.context?.argv,
          message: params.message,
          ...(reason ? { reason } : {}),
        },
      });
      log(
        `auto-approved host action for ${boxId}: ${params.context?.command ?? params.message}` +
          (reason ? ` (${reason})` : ''),
      );
    },
  });
  const hostInitiatedTokens = new HostInitiatedTokens();
  let queuePoke: (() => void) | null = null;
  const host = opts.host ?? '0.0.0.0';
  const mode: RelayMode = opts.mode ?? 'host';
  // Box mode parks host-only RPCs until the host poller answers; host mode
  // executes them inline (the historical behavior).
  const hostActions = mode === 'box' ? new HostActionQueue() : null;
  // A control box brokers rather than executes: actions that need the user's own
  // files park here for that machine's relay to drain.
  const hostReach =
    opts.controlPlane === true
      ? new HostReachQueue(
          typeof opts.hostReachTimeoutMs === 'number' && opts.hostReachTimeoutMs > 0
            ? { reachTimeoutMs: opts.hostReachTimeoutMs }
            : {},
        )
      : null;
  // Host-mode handler for refreshed agent credentials (newest-wins backup
  // write + debounced `agentbox credentials propagate` spawn). In box mode the
  // event rides the local ring buffer to the bridge instead — the host's
  // poller hands it to this handler on the other side.
  // `custody` is the control box's store — passing it is what lets an accepted
  // token reach custody, so the next hub create seeds a current credential
  // instead of the last one a PC pushed. Absent on a localhost relay (no store).
  const credentialsFanout =
    mode === 'box' ? null : new CredentialsFanout({ log, custody: opts.custody ?? null });
  if (mode === 'box' && (!opts.bridgeToken || opts.bridgeToken.length === 0)) {
    throw new Error("relay mode='box' requires a non-empty bridgeToken");
  }
  const bridgeToken = opts.bridgeToken ?? '';
  // The laptop relay blocks on a human for approvals (today's behavior). The
  // stateless hosted plane uses 'poll' via its own handler, not this server.
  const promptMode: PromptMode = opts.promptMode ?? 'block';
  const gateDeps: GateDeps = { mode: promptMode, store, prompts, subscribers };
  // GitHub App leaser for `git.lease-token` (hosted plane). Off when no App is
  // configured — the laptop relay never needs it (it pushes host-side / cloud
  // boxes reach it via the poller).
  const githubAppConfig = opts.githubApp === undefined ? loadGitHubAppConfig() : opts.githubApp;
  const leaser = githubAppConfig ? new GitHubAppLeaser(githubAppConfig) : null;
  const custody = opts.custody ?? null;
  const custodyAdminToken = opts.adminToken ?? '';
  const custodyMaxBodyBytes =
    typeof opts.custodyMaxBodyBytes === 'number' && opts.custodyMaxBodyBytes > 0
      ? opts.custodyMaxBodyBytes
      : DEFAULT_CUSTODY_MAX_BODY_BYTES;
  const custodyMaxBlobBytes =
    typeof opts.custodyMaxBlobBytes === 'number' && opts.custodyMaxBlobBytes > 0
      ? opts.custodyMaxBlobBytes
      : DEFAULT_CUSTODY_MAX_BLOB_BYTES;
  const uiHandler = opts.uiHandler;

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
        // True when a Next UI is delegated here (the embedded hub) vs a bare relay.
        // Lets `agentbox hub` distinguish "a hub already runs" from "a lean relay
        // holds the port" (reclaim + respawn as the hub).
        ui: Boolean(uiHandler),
        cliEntry: Boolean(process.env.AGENTBOX_CLI_ENTRY),
        // The spawning CLI's version/commit (inherited via env at spawn time).
        // `version` lets host-side ensureRelay reclaim a relay left over from a
        // different agentbox version; `commit` is observability-only.
        version: process.env.AGENTBOX_CLI_VERSION || undefined,
        commit: process.env.AGENTBOX_CLI_COMMIT || undefined,
        // The running hub's profile + whether the resident create worker is on.
        // `agentbox hub expose` flips a localhost hub to the `hetzner` profile;
        // reporting it here lets host-side `ensureHub` reclaim a hub running in
        // the wrong mode (a plain localhost hub while deploy.json says exposed),
        // and `hub status` show what is actually running.
        profile: process.env.AGENTBOX_HUB_PROFILE || undefined,
        worker: process.env.AGENTBOX_HUB_WORKER === 'on' ? true : undefined,
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
        const status = only ? ((await store.getStatus(only.boxId)) ?? null) : null;
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

    // The blob surface must be dispatched BEFORE the JSON one, because it is the
    // only path that does not buffer the body — handing a 100 MiB carry payload
    // to `readRawBody` below is exactly what this route exists to avoid. The
    // request object IS the stream; nothing has consumed it yet.
    if (isCustodyBlobPath(url.pathname)) {
      const blobRes = await handleCustodyBlobRequest(
        {
          method: req.method ?? 'GET',
          path: url.pathname,
          bearer: bearerToken(req),
          body: req.method === 'PUT' ? req : undefined,
          maxBytes: custodyMaxBlobBytes,
        },
        { custody, adminToken: custodyAdminToken, log },
      );
      if (blobRes) {
        if (blobRes.stream) {
          res.writeHead(blobRes.status, {
            'content-type': 'application/octet-stream',
            ...(blobRes.entry ? { 'content-length': String(blobRes.entry.size) } : {}),
            ...(blobRes.entry ? { 'x-agentbox-sha256': blobRes.entry.sha256 } : {}),
          });
          blobRes.stream.pipe(res);
          blobRes.stream.on('error', () => res.destroy());
        } else {
          send(res, blobRes.status, blobRes.body ?? null);
        }
        return;
      }
    }

    // The user's machine draining actions this control box parked for it.
    //
    // Admin-bearer-gated, NOT loopback-gated — the same rule, and the same
    // reason, as custody: on a control box every request arrives through Caddy
    // on the same host, so "looks loopback" proves nothing, and a box could
    // otherwise poll this surface to read other boxes' actions or forge their
    // results. Dispatched before the loopback gate below for that reason.
    if (url.pathname.startsWith('/admin/hostreach')) {
      if (!hostReach) {
        send(res, 404, { error: 'host-reach is served only by a control box' });
        return;
      }
      if (custodyAdminToken.length === 0) {
        send(res, 503, { error: 'host-reach not configured: admin token unset' });
        return;
      }
      if (!timingSafeEqualStr(bearerToken(req) ?? '', custodyAdminToken)) {
        send(res, 401, { error: 'invalid admin token' });
        return;
      }
      if (route === 'GET /admin/hostreach/poll') {
        const requested = Number.parseInt(url.searchParams.get('wait') ?? '', 10);
        // Bounded server-side: a client asking to be held for an hour would tie
        // up a connection past every proxy's idle timeout.
        const waitMs = Number.isFinite(requested)
          ? Math.min(Math.max(requested, 0), MAX_HOSTREACH_WAIT_MS)
          : DEFAULT_HOSTREACH_WAIT_MS;
        const actions = await hostReach.poll(waitMs);
        send(res, 200, { actions });
        return;
      }
      // The outbox: copies out of a box that were waiting for this machine.
      if (route === 'GET /admin/hostreach/outbox') {
        const items = custody ? await listCpOutbox(custody) : [];
        send(res, 200, { items });
        return;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/admin/hostreach/outbox/')) {
        const id = decodeURIComponent(url.pathname.slice('/admin/hostreach/outbox/'.length));
        const items = custody ? await listCpOutbox(custody) : [];
        const hit = items.find((i) => i.meta.id === id);
        if (!hit || !custody) {
          send(res, 404, { error: 'no such parked copy' });
          return;
        }
        await removeCpOutboxItem(custody, hit);
        log(`cp outbox: ${id} landed and cleared`);
        send(res, 204, null);
        return;
      }
      if (route === 'POST /admin/hostreach/result') {
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
        const ok = hostReach.resolve(body.id, {
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

    // Custody (`/admin/custody/*`) is admin-bearer-gated, NOT loopback-gated:
    // on the control box the hub sits behind Caddy on the same host, so every
    // proxied request looks loopback. The shared dispatcher enforces the bearer
    // (and fail-closes with 503 when custody or the admin token is unset), so
    // this must run BEFORE the loopback rejection below.
    if (url.pathname === '/admin/custody' || url.pathname.startsWith('/admin/custody/')) {
      const bodyText =
        req.method === 'PUT' || req.method === 'POST'
          ? await readRawBody(req, custodyMaxBodyBytes)
          : '';
      const custodyRes = await handleCustodyRequest(
        {
          method: req.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          bearer: bearerToken(req),
          bodyText,
        },
        { custody, adminToken: custodyAdminToken, log },
      );
      if (custodyRes) {
        send(res, custodyRes.status, custodyRes.body ?? null);
        return;
      }
    }

    // Create-queue surface (`/remote/boxes`) — admin-bearer-gated like custody
    // (not loopback: the control box is behind Caddy). The shared dispatcher is
    // the SAME one the Vercel plane's `core/handler.ts` mounts, so the PC can
    // `agentbox create --via-hub` against the control box exactly as against the
    // hosted plane. Runs before the loopback rejection below.
    if (isRemoteBoxesPath(url.pathname)) {
      const bodyText = req.method === 'POST' ? await readRawBody(req) : '';
      const remoteRes = await handleRemoteBoxesRequest(
        {
          method: req.method ?? 'GET',
          path: url.pathname,
          bearer: bearerToken(req),
          bodyText,
          query: url.searchParams,
        },
        { store, adminToken: custodyAdminToken, custody, readJobLog: readCreateJobLog, log },
      );
      if (remoteRes) {
        send(res, remoteRes.status, remoteRes.body ?? null);
        return;
      }
    }

    // Generic Store RPC (`/admin/store`) — admin-bearer-gated shared dispatcher,
    // the same one `core/handler.ts` mounts, so a PC's RemoteStore reads the
    // control box's registry/status/events over HTTP. Carries its own bearer
    // gate (not loopback: the control box is behind Caddy), so it runs before the
    // loopback rejection below. A laptop relay has no admin token → 503.
    if (isStoreRpcPath(url.pathname)) {
      const bodyText = req.method === 'POST' ? await readRawBody(req) : '';
      const storeRpcRes = await handleStoreRpcRequest(
        {
          method: req.method ?? 'GET',
          path: url.pathname,
          bearer: bearerToken(req),
          bodyText,
        },
        { store, adminToken: custodyAdminToken, log },
      );
      if (storeRpcRes) {
        send(res, storeRpcRes.status, storeRpcRes.body ?? null);
        return;
      }
    }

    // Admin endpoints are reachable from loopback, or — on a relay with an
    // admin token configured (the control box) — with that bearer. The relay
    // binds to 0.0.0.0 so containers can reach /events and /rpc via
    // host.docker.internal, but admin operations (register-box, forget-box,
    // list events, etc.) are for the host CLI / an authenticated admin and must
    // not be exposed to boxes. A laptop relay sets no admin token, so its gate
    // stays loopback-only. Any other `/remote/*` is a hosted-plane surface not
    // served by this relay.
    if (url.pathname.startsWith('/admin/') || url.pathname.startsWith('/remote/')) {
      if (url.pathname.startsWith('/remote/')) {
        send(res, 404, { error: 'not found', route });
        return;
      }
      const loopback = isLoopbackAddress(req.socket.remoteAddress);
      if (!adminGateAllows(loopback, bearerToken(req), custodyAdminToken)) {
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
        // Push it to attached wrappers. The durable file only serves a footer on
        // THIS machine; a box owned by a remote hub has no such file on the
        // user's laptop, so the stream is the only way its footer learns the
        // agent activity and the `starting N/M…` service count.
        subscribers.broadcast(reg.boxId, BOX_STATUS_EVENT, body.payload);
        log(`box-status box=${reg.boxId}`);
        send(res, 202, { ok: true });
        return;
      }
      // Refreshed agent credentials: handled out-of-band in host mode — the
      // payload is a secret and must never land in the event ring buffer. In
      // box mode it falls through to the ring so the bridge drains it to the
      // host poller (which routes it to the host relay's handler).
      if (body.type === CREDENTIALS_UPDATED_EVENT && credentialsFanout) {
        const verdict = await credentialsFanout.handle(reg.boxId, body.payload);
        log(
          `credentials-updated box=${reg.boxId} accepted=${String(verdict.accepted)} (${verdict.reason})`,
        );
        send(res, 202, { ok: true, accepted: verdict.accepted });
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
        // Cloud box reaching this host-mode relay directly over the forwarder
        // (rather than via the poller): run the cloud bundle pull-back executor,
        // which does its own gating and pushes via the host workspace.
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
            autoApproveSafeHostActions: reg.autoApproveSafeHostActions,
            originUrl: reg.originUrl,
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
          const hostOnlyParams = body.params as GitRpcParams | undefined;
          if (hostOnlyParams?.hostOnly) {
            // Landing the branch in the host's local repo publishes nothing,
            // so the push-confirm gate doesn't apply. Land and return.
            const saveResult = await handleGitSaveToHost(reg, hostOnlyParams);
            send(res, saveResult.exitCode === 0 ? 200 : 500, saveResult);
            return;
          }
          const params = body.params as GitRpcParams | undefined;
          const worktree = resolveWorktree(reg, params?.path ?? '/workspace');
          // The docker relay always pushes the worktree's host-selected branch
          // (`sanctionedBranch`, falling back to the create-time `branch`) — the
          // in-box agent can't influence which branch is pushed. Key the gate on
          // THAT branch, not the immutable create-time `branch` (which is always
          // `agentbox/*`): after a host `agentbox git checkout main`, the push
          // target is `main`, so it must NOT be treated as a scratch bypass.
          // A scratch target bypasses unconditionally; a non-scratch sanctioned
          // target bypasses only as part of the safe subset (honors
          // `box.autoApproveSafeHostActions`) and leaves an audit trail.
          const dockerPushBranch = worktree?.sanctionedBranch ?? worktree?.branch;
          const isScratch = isScratchBranch(dockerPushBranch);
          const safeApproveOn = reg.autoApproveSafeHostActions !== false;
          // `isSanctionedPushBranch(dockerPushBranch, dockerPushBranch)` is true
          // only for a resolved branch — so a box with no registered worktree
          // (undefined branch) never bypasses and still prompts.
          const isSanctionedNonScratch =
            !isScratch &&
            safeApproveOn &&
            isSanctionedPushBranch(dockerPushBranch, dockerPushBranch);
          const bypassPushGate = isScratch || isSanctionedNonScratch;
          if (isSanctionedNonScratch) {
            prompts.noteAutoApprove(
              reg.boxId,
              {
                kind: 'confirm',
                message: `git push to sanctioned branch ${dockerPushBranch ?? ''} from box ${reg.name}`,
                context: { command: 'git push', cwd: params?.path, argv: params?.args },
              },
              'safe: sanctioned-branch push',
            );
          }
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
            !bypassPushGate &&
            tokenClaimed &&
            hostInitiatedTokens.consume(params?.hostInitiated, reg.boxId, 'git.push', incomingHash);
          if (!bypassPushGate && tokenClaimed && !hostInitiatedOk) {
            send(res, 500, {
              exitCode: 10,
              stdout: '',
              stderr:
                'host-initiated token rejected: invalid, expired, or bound to different params\n',
            });
            return;
          }
          if (!bypassPushGate && !hostInitiatedOk) {
            const gate = await gateApproval(gateDeps, reg.boxId, 'git.push', body.params, {
              kind: 'confirm',
              message: `Allow git push from box ${reg.name}?`,
              detail: `${resolveRemote(params?.remote)} ${(params?.args ?? []).join(' ')}`.trim(),
              defaultAnswer: 'n',
              context: {
                command: 'git push',
                cwd: params?.path,
                argv: params?.args,
              },
            });
            // Poll mode: parked — the box polls /rpc/status/<promptId> for the
            // verdict + result (the push runs there, on approval).
            if (gate.kind === 'pending') {
              send(res, 202, { status: 'pending', promptId: gate.promptId });
              return;
            }
            if (gate.kind === 'deny') {
              send(res, 500, { exitCode: 10, stdout: '', stderr: 'denied by user\n' });
              return;
            }
          }
        }
        const result = await handleGitRpc(
          reg,
          body.method,
          body.params as GitRpcParams | undefined,
        );
        const status = result.exitCode === 0 ? 200 : 500;
        send(res, status, result);
        return;
      }
      if (body.method === 'git.lease-token') {
        // The hosted-plane equivalent of git.push: instead of the relay pushing,
        // it leases a repo-scoped GitHub-App token and the box pushes directly.
        // Because that token can push ANY branch (the relay doesn't pick the
        // branch here, unlike git.push), the sanctioned-branch auto-approve does
        // NOT apply — only the box's own scratch branch bypasses; others prompt.
        const params = body.params as GitRpcParams | undefined;
        const worktree = resolveWorktree(reg, params?.path ?? '/workspace');
        const isAgentboxBranch = isScratchBranch(worktree?.branch);
        if (!isAgentboxBranch) {
          const gate = await gateApproval(gateDeps, reg.boxId, 'git.lease-token', body.params, {
            kind: 'confirm',
            message: `Allow box ${reg.name} to lease a push token for ${reg.originUrl ?? 'its repo'}?`,
            detail: `branch ${worktree?.branch ?? '(unregistered)'}`,
            defaultAnswer: 'n',
            context: { command: 'git lease-token', cwd: params?.path },
          });
          if (gate.kind === 'pending') {
            send(res, 202, { status: 'pending', promptId: gate.promptId });
            return;
          }
          if (gate.kind === 'deny') {
            send(res, 500, { exitCode: 10, stdout: '', stderr: 'denied by user\n' });
            return;
          }
        }
        const result = await leaseTokenResult(leaser, reg);
        send(res, result.exitCode === 0 ? 200 : 500, result);
        return;
      }
      if (
        hostReach &&
        reg.kind === 'cloud' &&
        (body.method === 'cp.toHost' || body.method === 'cp.fromHost') &&
        !(await boxWorkspaceExistsHere(reg.boxId))
      ) {
        // A control box has neither the user's files nor a live checkout to
        // resolve them against, so it brokers instead of executing: park the
        // action for the machine that does, and let THAT machine gate it. The
        // gate belongs with the executor — deciding "contained in the project"
        // here would judge a path that does not exist on this disk (it is the
        // create job's deleted temp clone), which is how a copy the user never
        // saw got auto-approved as safe.
        const cachePrefix = cpCachePrefix({
          projectSlug: reg.originUrl
            ? (projectSlugFromOriginUrl(reg.originUrl) ?? undefined)
            : undefined,
          boxId: reg.boxId,
        });
        const outcome = await hostReach.request(reg.boxId, body.method, body.params, {
          cachePrefix,
        });
        if (outcome.kind === 'result') {
          send(res, outcome.result.exitCode === 0 ? 200 : 500, outcome.result);
          return;
        }
        log(`cp ${body.method} for ${reg.boxId}: host unreachable (${outcome.reason})`);
        // The machine is offline — but a copy it made earlier may be in custody.
        // Only reads can be served that way: an outbound copy has nowhere to go
        // until that machine is back (see the outbox in `cp.toHost` below).
        if (body.method === 'cp.fromHost') {
          const cached = await serveCachedCp({
            params: body.params as CpRpcParams | undefined,
            reg,
            custody,
            cachePrefix,
            prompts,
            subscribers,
            log,
          });
          if (cached) {
            send(res, cached.exitCode === 0 ? 200 : 500, cached);
            return;
          }
        } else {
          // Outbound: nothing to fall back to, but the bytes are still in the
          // box. Take them now and hold them for the machine, rather than
          // letting an agent's output evaporate because a laptop was shut.
          const parked = await parkOutboundCp({
            params: body.params as CpRpcParams | undefined,
            reg,
            custody,
            maxBytes: custodyMaxBlobBytes,
            log,
          });
          if (parked) {
            send(res, parked.exitCode === 0 ? 200 : 500, parked);
            return;
          }
        }
        send(res, 500, {
          exitCode: 69,
          stdout: '',
          stderr: cpUnreachableMessage(body.method, reg.name, outcome.reason, {
            cacheMiss: body.method === 'cp.fromHost',
          }),
        });
        return;
      }
      if (body.method === 'cp.toHost' || body.method === 'cp.fromHost') {
        const params = body.params as CpRpcParams | undefined;
        let norm: { sources: string[]; dest: string };
        try {
          norm = normalizeCpParams(body.method, params);
        } catch (err) {
          send(res, 400, { error: err instanceof Error ? err.message : String(err) });
          return;
        }
        if (
          params!.exclude !== undefined &&
          (!Array.isArray(params!.exclude) || params!.exclude.some((p) => typeof p !== 'string'))
        ) {
          send(res, 400, { error: 'cp.* exclude must be an array of strings' });
          return;
        }
        const direction = body.method === 'cp.toHost' ? 'box -> host' : 'host -> box';
        // Resolve host paths against THIS box's workspace so a relative path
        // doesn't land under the relay daemon's CWD (whichever project started
        // the relay), and so the consent prompt shows the real destination.
        const workspacePath = await boxWorkspacePath(reg.boxId);
        const {
          argv: cpArgs,
          detail,
          contextArgv,
        } = buildCpArgv({
          method: body.method,
          boxName: reg.name,
          sources: norm.sources,
          dest: norm.dest,
          resolveHost: (p) => resolveHostPath(workspacePath, p),
          flags: cpFlags(params!),
        });
        const detailParts = [detail];
        if (params!.exclude && params!.exclude.length > 0) {
          detailParts.push(`exclude: ${params!.exclude.join(', ')}`);
        }
        if (params!.defaultExcludes === false) detailParts.push('(default excludes off)');
        if (params!.yes) detailParts.push('(over size limit — confirmed)');
        // Auto-approve a transfer that stays inside the box's project folder
        // (box->host: check the dest; host->box: check the sources, keeping
        // secret files behind the prompt). Anything else prompts as before.
        const cpHostPaths =
          body.method === 'cp.toHost'
            ? [resolveHostPath(workspacePath, norm.dest)]
            : norm.sources.map((s) => resolveHostPath(workspacePath, s));
        const cpAuto = await canAutoApproveTransfer({
          enabled: reg.autoApproveSafeHostActions !== false,
          workspacePath,
          hostPaths: cpHostPaths,
          checkSecret: body.method === 'cp.fromHost',
          carried: body.method === 'cp.fromHost' ? await boxCarriedHostPaths(reg.boxId) : undefined,
        });
        if (cpAuto) {
          prompts.noteAutoApprove(
            reg.boxId,
            {
              kind: 'confirm',
              message: `cp (${direction}) on ${reg.name}`,
              detail: detailParts.join('\n'),
              context: { command: body.method, argv: contextArgv },
            },
            body.method === 'cp.toHost'
              ? 'safe: contained copy to host'
              : 'safe: contained copy from host',
          );
        } else {
          const verdict = await askPrompt(prompts, subscribers, reg.boxId, {
            kind: 'confirm',
            message: `Allow cp (${direction}) on ${reg.name}?`,
            detail: detailParts.join('\n'),
            defaultAnswer: 'n',
            context: {
              command: body.method,
              argv: contextArgv,
            },
          });
          if (verdict.answer !== 'y') {
            send(res, 500, { exitCode: 10, stdout: '', stderr: 'denied by user\n' });
            return;
          }
        }
        const result = await handleCpRpc(cpArgs, workspacePath);
        const status = result.exitCode === 0 ? 200 : 500;
        send(res, status, result);
        return;
      }
      if (body.method === 'gh.exec') {
        const result = await handleGhExecRpc(
          reg,
          body.params as GhExecRpcParams | undefined,
          prompts,
          subscribers,
          hostInitiatedTokens,
        );
        const status = result.exitCode === 0 ? 200 : 500;
        send(res, status, result);
        return;
      }
      if (body.method.startsWith('tool.')) {
        const result = await handleToolRpc(
          body.method,
          reg,
          body.params as Record<string, unknown> | undefined,
          prompts,
          subscribers,
        );
        const status = result.exitCode === 0 ? 200 : 500;
        send(res, status, result);
        return;
      }
      if (body.method === 'git.clone' || body.method === 'gh.repo.clone') {
        // Clone bundle-ship-back machinery is deferred to a follow-up PR
        // The shim + ctl plumbing is in place so the next iteration only has
        // to land the relay-side host clone + bundle + box transfer.
        send(res, 501, {
          exitCode: 64,
          stdout: '',
          stderr: `${body.method}: not yet implemented for this box. Run \`gh\` / \`git\` on the host directly for now.\n`,
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
        const kind = parseDownloadKind(body.method);
        // `download.workspace` lands under the box's project folder (contained by
        // construction), so it auto-approves under the safe flag. The env/config/
        // claude kinds land in ~/.agentbox / ~/.claude (outside the project) and
        // keep prompting.
        const dlWorkspace = await boxWorkspacePath(reg.boxId);
        const dlAuto =
          kind === 'workspace' &&
          (await canAutoApproveTransfer({
            enabled: reg.autoApproveSafeHostActions !== false,
            workspacePath: dlWorkspace,
            hostPaths: dlWorkspace ? [dlWorkspace] : [],
            checkSecret: false,
          }));
        if (dlAuto) {
          prompts.noteAutoApprove(
            reg.boxId,
            {
              kind: 'confirm',
              message: `download (${kind}) from ${reg.name}`,
              detail: params?.hostPath ?? '(default host location)',
              context: { command: body.method, argv: params?.hostPath ? [params.hostPath] : [] },
            },
            'safe: contained download',
          );
        } else {
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

    // Poll-mode verdict + result for a parked approval (see ./permission.ts).
    // The box polls this after a `/rpc` returned `202 {promptId}`:
    //   - pending          → keep polling
    //   - denied/cancelled → exit 10
    //   - approved         → run the action once, cache the result, return it
    if (req.method === 'GET' && url.pathname.startsWith('/rpc/status/')) {
      const reg = await authBox(req, res);
      if (!reg) return;
      const promptId = decodeURIComponent(url.pathname.slice('/rpc/status/'.length));
      const row = await store.getPrompt(promptId);
      if (!row || row.boxId !== reg.boxId) {
        send(res, 404, { error: 'no such prompt', promptId });
        return;
      }
      if (row.status === 'pending') {
        send(res, 200, { status: 'pending' });
        return;
      }
      if (row.answer !== 'y' || row.cancelled) {
        send(res, 200, {
          status: 'done',
          result: { exitCode: 10, stdout: '', stderr: 'denied by user\n' },
        });
        return;
      }
      // Approved. Idempotent: a cached result short-circuits re-polls; the box
      // polls sequentially so there is no concurrent first-execute race here.
      const cached = row.result;
      const result = cached ?? (await dispatchApprovedAction(reg, row.method, row.params));
      if (!cached) await store.setPromptResult(promptId, result);
      send(res, 200, { status: 'done', result });
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
          typeof body.backend === 'string' && body.backend.length > 0 ? body.backend : undefined,
        sandboxId:
          typeof body.sandboxId === 'string' && body.sandboxId.length > 0
            ? body.sandboxId
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
        // Default on: only an explicit `false` disables the safe subset, so an
        // older wire body without the field stays relaxed.
        autoApproveSafeHostActions: body.autoApproveSafeHostActions !== false,
        originUrl:
          typeof body.originUrl === 'string' && body.originUrl.length > 0
            ? body.originUrl
            : undefined,
        publicHost:
          typeof body.publicHost === 'string' && body.publicHost.length > 0
            ? body.publicHost
            : undefined,
        image: typeof body.image === 'string' && body.image.length > 0 ? body.image : undefined,
        webPort:
          typeof body.webPort === 'number' && Number.isFinite(body.webPort) && body.webPort > 0
            ? Math.trunc(body.webPort)
            : undefined,
        agent: typeof body.agent === 'string' && body.agent.length > 0 ? body.agent : undefined,
        projectSlug:
          typeof body.projectSlug === 'string' && body.projectSlug.length > 0
            ? body.projectSlug
            : undefined,
      };
      await store.registerBox(reg);
      log(
        `registered ${kind} box ${reg.boxId} (${reg.name})` +
          (worktrees && worktrees.length > 0
            ? ` with ${String(worktrees.length)} worktree(s)`
            : ''),
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
                // Credential updates carry a secret blob — route to the
                // fan-out handler, never into the host event ring buffer.
                if (ev.type === CREDENTIALS_UPDATED_EVENT && credentialsFanout) {
                  const verdict = await credentialsFanout.handle(reg.boxId, ev.payload);
                  log(
                    `credentials-updated box=${reg.boxId} accepted=${String(verdict.accepted)} (${verdict.reason})`,
                  );
                  continue;
                }
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
                // Same reason as the direct-POST path above: this is the only
                // status source an attached footer has for a cloud box.
                subscribers.broadcast(reg.boxId, BOX_STATUS_EVENT, status);
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
                      autoApproveSafeHostActions: reg.autoApproveSafeHostActions,
                      originUrl: reg.originUrl,
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

    if (route === 'POST /admin/stop-poller') {
      const body = await readJsonBody<{ boxId?: string }>(req);
      if (!body || typeof body.boxId !== 'string' || body.boxId.length === 0) {
        send(res, 400, { error: 'expected {boxId}' });
        return;
      }
      // Deliberately NOT forget-box: the registration and status survive, so
      // `list`/the hub keep showing the box. This only silences the poller,
      // which has nothing to talk to while the box is paused — and on an
      // auto-resuming backend (e2b) would otherwise wake it right back up.
      if (pollers) await pollers.stop(body.boxId);
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
      // Poll mode parks prompts in the store; block mode keeps them in-process.
      const pending =
        promptMode === 'poll'
          ? (await store.listPendingPrompts(boxId)).map((r) => r.ev)
          : prompts.forBox(boxId);
      send(res, 200, { prompts: pending });
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
      // Poll mode: the answer lands on the store row; the box's /rpc/status
      // poll picks it up and runs (or denies) the parked action.
      if (promptMode === 'poll') {
        const row = await store.getPrompt(body.id);
        const hit = await store.answerPrompt(body.id, body.answer, body.cancelled);
        if (!hit) {
          send(res, 404, { error: 'no pending prompt with that id' });
          return;
        }
        if (row) subscribers.broadcast(row.boxId, 'prompt-resolved', { id: body.id });
        send(res, 204, null);
        return;
      }
      // Block mode: resolve the in-process pending Promise (the parked /rpc
      // call unblocks and runs/denies inline). Find the owning box first so we
      // can target the prompt-resolved broadcast (other wrappers clear their
      // stale footer).
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
      log(
        `host-initiated-mint box=${body.boxId} method=${body.method} paramsBound=${paramsHash !== null}`,
      );
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

    if (uiHandler) {
      uiHandler(req, res);
      return;
    }
    send(res, 404, { error: 'not found', route });
  }

  /**
   * Run a host action that has already cleared its approval gate (poll mode:
   * the box reached `/rpc/status` after a `y`). No re-gating here. Extended per
   * method as the hosted plane grows.
   */
  async function dispatchApprovedAction(
    reg: BoxRegistration,
    method: string,
    params: unknown,
  ): Promise<GitRpcResult> {
    if (method === 'git.push' || method === 'git.fetch') {
      return handleGitRpc(reg, method, params as GitRpcParams | undefined);
    }
    if (method === 'git.lease-token') {
      return leaseTokenResult(leaser, reg);
    }
    return {
      exitCode: 64,
      stdout: '',
      stderr: `relay: no approved-action executor for ${method}\n`,
    };
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
    hubNotifier,
    custody,
    hostActions: hostActions ?? undefined,
    hostReach: hostReach ?? undefined,
    url: `http://${host}:${String(opts.port)}`,
    setQueuePoke: (fn) => {
      queuePoke = fn;
    },
    pokeQueue: () => {
      queuePoke?.();
    },
    stopCloudPoller: async (boxId) => {
      if (pollers) await pollers.stop(boxId);
    },
    close: async () => {
      if (pollers) await pollers.stopAll();
      // Settles every parked copy as unreachable, so an in-flight `cp` fails
      // fast on hub restart instead of hanging until the box's own timeout.
      hostReach?.stop();
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
        ...(typeof w.sanctionedBranch === 'string' && w.sanctionedBranch.length > 0
          ? { sanctionedBranch: w.sanctionedBranch }
          : {}),
      });
    }
  }
  return out;
}

/**
 * git.push --host-only: make the box's branch available in the host's *local*
 * repo without pushing to any remote. Docker boxes commit against the
 * bind-mounted `.git/`, so the box's branch ref already lives in the host repo;
 * we just copy it to the requested destination ref via a self-fetch (which
 * enforces fast-forward and works even though the source branch is checked out
 * in the worktree). When the destination equals the source branch this is a
 * no-op success — the branch is already on the host.
 */
async function handleGitSaveToHost(
  reg: BoxRegistration,
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
  // Land the branch the box is actually on (its host-sanctioned branch, updated
  // by `agentbox git checkout`), matching what `git.push` publishes — not the
  // stale create-time scratch ref.
  const src = worktree.sanctionedBranch ?? worktree.branch;
  const dest = resolveLandDest(src, params?.as);
  if (dest === src) {
    return {
      exitCode: 0,
      stdout: `branch ${dest} already available in ${worktree.hostMainRepo}\n`,
      stderr: '',
    };
  }
  const refspec = landRefspec(src, dest, params?.force);
  const result = await runHostCommand(['git', '-C', worktree.hostMainRepo, 'fetch', '.', refspec]);
  if (result.exitCode === 0) {
    return {
      exitCode: 0,
      stdout: `branch ${dest} available in ${worktree.hostMainRepo}\n${result.stdout}`,
      stderr: result.stderr,
    };
  }
  return result;
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
  // A worker-created (hub) box registered its `hostMainRepo` as the create-time
  // seed clone (a temp dir deleted after create), so `git -C <that>` would fail
  // cryptically. Reject fail-closed with a clear message instead.
  const unavailable = hostRepoUnavailableReason(worktree, reg.boxId, method);
  if (unavailable) {
    return { exitCode: 64, stdout: '', stderr: unavailable };
  }
  const op = method === 'git.push' ? 'push' : 'fetch';
  const remote = resolveRemote(params?.remote);
  // Operate on the host-sanctioned branch (updated by `agentbox git checkout`),
  // falling back to the create-time `branch` for records without the field.
  // The agent can't influence this — the relay picks the branch — so pushing
  // it is always host-controlled.
  const pushBranch = worktree.sanctionedBranch ?? worktree.branch;
  const argv = ['git', '-C', worktree.hostMainRepo, op, remote, pushBranch];
  argv.push(...sanitizeGitArgs(params?.args));
  const result = await runHostCommand(argv);
  // After a successful push, mirror what `git push -u` would have left behind:
  // make the branch track `origin/<branch>` so the in-box `git status` /
  // Claude Code's PR badge see an upstream. Skip per-box scratch branches
  // (`agentbox/<name>`) — they're local-only by design. Docker shares .git/
  // with the box, so update-ref of the remote-tracking ref already happened
  // during the push; only the upstream config is missing.
  if (method === 'git.push' && result.exitCode === 0 && !isScratchBranch(pushBranch)) {
    await runHostCommand([
      'git',
      '-C',
      worktree.hostMainRepo,
      'branch',
      `--set-upstream-to=${upstreamRef(remote, pushBranch)}`,
      pushBranch,
    ]);
  }
  return result;
}

/**
 * `gh.exec`: run the host's `gh` with the box's argv.
 *
 * One handler for the whole CLI, replacing the old per-subcommand allowlist
 * (`gh.pr.<op>` / `gh.run.<op>` / `gh.api`) that refused anything it had not
 * been taught — which is what made `gh issue` unreachable (issue #304).
 * Policy now lives in three small lists in `gh.ts`: blocked outright,
 * always-confirmed, and everything else allow-once.
 *
 * Runs with `cwd = worktree.hostMainRepo` so `gh` infers the repo from that
 * repo's `git remote -v`. `pr` keeps two pieces of special handling that are
 * about correctness rather than policy: the box's branch is injected into a
 * headless `pr create`, and `pr checkout` stays opt-in because it moves the
 * HOST's working tree.
 */
async function handleGhExecRpc(
  reg: BoxRegistration,
  params: GhExecRpcParams | undefined,
  prompts: PendingPrompts,
  subscribers: PromptSubscribers,
  hostInitiatedTokens: HostInitiatedTokens,
): Promise<GitRpcResult> {
  const args = Array.isArray(params?.args)
    ? params.args.filter((a): a is string => typeof a === 'string')
    : [];
  if (args.length === 0) {
    return { exitCode: 64, stdout: '', stderr: 'gh: no arguments\n' };
  }

  const blocked = refuseBlockedGhCall(args);
  if (blocked) return blocked;

  // Read the verb past any leading global flags, so `gh -R o/r pr checkout`
  // is still recognised as a checkout.
  const verb = ghVerbArgv(args);
  const family = verb[0] ?? '';
  const op = verb[1] ?? '';
  if (family === 'pr') {
    const checkoutOptIn = refuseCheckoutByDefault(op);
    if (checkoutOptIn) return checkoutOptIn;
  }
  if (family === 'api') {
    const inputRefusal = refuseGhApiInput(args);
    if (inputRefusal) return inputRefusal;
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
  // `tools.gh.enabled: false` revokes the built-in grant. Per call, layered,
  // and before any host probe, so a revoked gh never surfaces as a prompt.
  const ghRevoked = await refuseIfGhDisabled(worktree.hostMainRepo);
  if (ghRevoked) return ghRevoked;

  const ghTarget = await resolveGhTarget(reg.originUrl);
  if (ghTarget.error) return ghTarget.error;

  if (family === 'pr' && op === 'checkout') {
    // Refuse a host checkout onto ANY branch a box currently occupies — its
    // create-time scratch ref AND its host-sanctioned branch — either of
    // which the bind-mounted `.git/HEAD` would corrupt.
    const branches = (reg.worktrees ?? []).flatMap((w) =>
      w.sanctionedBranch && w.sanctionedBranch !== w.branch
        ? [w.branch, w.sanctionedBranch]
        : [w.branch],
    );
    const guard = await checkoutGuards(worktree.hostMainRepo, branches);
    if (guard) return guard;
  }

  // Host-initiated calls (from `agentbox git pr <op> <box>`) skip the confirm
  // with a scope-matched, params-hash-bound one-time token. A token that is
  // present but invalid is a hard reject — that is an attack signal, not a
  // retry. Absent token falls through to the normal gate.
  const tokenClaimed = typeof params?.hostInitiated === 'string';
  const hostInitiatedOk =
    tokenClaimed &&
    hostInitiatedTokens.consume(params?.hostInitiated, reg.boxId, 'gh.exec', hashRpcParams(params));
  if (tokenClaimed && !hostInitiatedOk) {
    return {
      exitCode: 10,
      stdout: '',
      stderr: 'host-initiated token rejected: invalid, expired, or bound to different params\n',
    };
  }

  if (!hostInitiatedOk) {
    const destructive = ghDestructiveTarget(args);
    const label = `gh ${args.slice(0, 2).join(' ')}`.trim();
    const ctx = {
      kind: 'confirm' as const,
      message: destructive
        ? `Allow \`gh ${args.join(' ')}\` from box ${reg.name}? This destroys a ${destructive}.`
        : `Allow \`gh ${args.join(' ')}\` from box ${reg.name}?`,
      detail: args.join(' ').slice(0, 200),
      context: { command: label, cwd: containerPath, argv: args },
    };
    // Destructive ops confirm even when the box carries the auto-approve
    // flag: the flag says "don't interrupt me for ordinary work", not
    // "delete things without asking".
    if (destructive || reg.autoApproveSafeHostActions === false) {
      const verdict = await askPrompt(prompts, subscribers, reg.boxId, {
        ...ctx,
        defaultAnswer: 'n',
      });
      if (verdict.answer !== 'y') {
        return { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
      }
    } else {
      prompts.noteAutoApprove(reg.boxId, ctx, `allow-once: ${label}`);
    }
  }

  // A headless `pr create` must never fall back to the host repo's checked-out
  // branch. Injected AFTER token validation, which hashes the incoming params
  // rather than this rewritten argv.
  let finalArgs = args;
  if (family === 'pr') {
    // Rebuild around the ORIGINAL argv so leading global flags (`-R o/r`)
    // survive, and slice the op's tail off the NORMALIZED argv so the verb is
    // not duplicated.
    const head = args.slice(0, args.length - verb.length);
    const rest = injectPrCreateHead(
      op,
      worktree.sanctionedBranch ?? worktree.branch,
      verb.slice(2),
    );
    if (prCreateNeedsHead(op, rest)) return PR_CREATE_NO_HEAD_REFUSAL;
    finalArgs = [...head, family, op, ...rest];
  }
  const run = ghRunContext(worktree.hostMainRepo, reg.originUrl, finalArgs);
  return runHostGh(run.args, run.cwd, { host: ghTarget.host });
}

/**
 * `tool.list` / `tool.request` / `tool.run`: the generic host-tool proxy.
 *
 * `tool.run`'s gate order is load-bearing, cheapest-and-most-absolute first:
 *   1. worktree resolve      — exit 64, nothing to run in
 *   2. grant lookup          — exit 65, re-read every call so an approval is live
 *   3. built-in deny list    — exit 65, before any prompt or spawn
 *   4. per-tool deny rules   — exit 65, layered on top, never replacing (3)
 *   5. allow rules / gate    — silent when explicitly allowed or when the box
 *                              runs with `box.autoApproveSafeHostActions`
 *                              (default), else a host prompt; deny → exit 10
 *   6. spawn in hostMainRepo — the host's own credentials, buffered, no TTY
 *
 * Every failure returns the same `{exitCode, stdout, stderr}` envelope as the
 * gh handlers, and `host-actions.ts` runs the identical sequence for cloud
 * boxes, per the "fix across all providers" rule.
 */
async function handleToolRpc(
  method: string,
  reg: BoxRegistration,
  params: Record<string, unknown> | undefined,
  prompts: PendingPrompts,
  subscribers: PromptSubscribers,
): Promise<GitRpcResult> {
  const containerPath = typeof params?.['path'] === 'string' ? params['path'] : '/workspace';
  const worktree = resolveWorktree(reg, containerPath);
  if (!worktree) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: `no worktree registered for box ${reg.boxId} matching ${containerPath}`,
    };
  }
  const cwd = worktree.hostMainRepo;

  if (method === 'tool.list') {
    const grants = await loadGrantedTools(cwd);
    const json = params?.['format'] === 'json';
    return {
      exitCode: 0,
      stdout: json ? renderToolListJson(grants.values()) : renderToolList(grants.values()),
      stderr: '',
    };
  }

  const name = typeof params?.['name'] === 'string' ? params['name'].trim() : '';
  if (!name || !isValidToolName(name)) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: `${method}: missing or invalid tool name\n`,
    };
  }

  if (method === 'tool.request') {
    const reason =
      typeof (params as ToolRequestRpcParams | undefined)?.reason === 'string'
        ? String(params?.['reason']).slice(0, 500)
        : '';
    return handleToolRequest(name, reason, reg, cwd, containerPath, prompts, subscribers);
  }

  if (method !== 'tool.run') {
    return { exitCode: 64, stdout: '', stderr: `unknown tool method: ${method}\n` };
  }

  const resolved = await resolveToolGrant(name, cwd);
  if ('refusal' in resolved) return resolved.refusal;
  const grant = resolved.grant;

  const args = Array.isArray(params?.['args'])
    ? (params['args'] as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];

  const credRefusal = refuseCredentialArgv(name, args, grant.bin);
  if (credRefusal) return credRefusal;
  const denyRefusal = refuseDeniedArgv(grant, args);
  if (denyRefusal) return denyRefusal;

  const promptEvent = {
    kind: 'confirm' as const,
    message: `Allow \`${grant.bin} ${args.join(' ')}\` on the host from box ${reg.name}?`,
    detail: `runs with the host's own ${grant.bin} credentials in ${cwd}`,
    context: { command: `tool ${name}`, cwd: containerPath, argv: args },
  };

  if (argvIsExplicitlyAllowed(grant, args)) {
    prompts.noteAutoApprove(reg.boxId, promptEvent, `allow-rule: tool ${name}`);
  } else if (reg.autoApproveSafeHostActions !== false) {
    // The grant itself was the human decision; the per-call prompt is the
    // opt-in stricter mode. Still audited so every host-tool call is visible
    // in the relay event ring buffer.
    prompts.noteAutoApprove(reg.boxId, promptEvent, `safe: tool ${name}`);
  } else {
    const verdict = await askPrompt(prompts, subscribers, reg.boxId, {
      ...promptEvent,
      defaultAnswer: 'n',
    });
    if (verdict.answer !== 'y') {
      return { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
    }
  }

  return runGrantedTool(grant, args, cwd);
}

/**
 * A box asking for a host CLI it doesn't have. The host PATH probe runs
 * BEFORE the prompt on purpose: the user explicitly wants a box that guesses
 * wrong (`tool request terrafrom`) to get a direct "not installed" answer
 * instead of interrupting them with an approval for a binary that could never
 * run. That does let a box learn whether a given binary exists on the host,
 * which is why requests are gated by `tools.request.enabled` and every one is
 * recorded as a relay event.
 */
async function handleToolRequest(
  name: string,
  reason: string,
  reg: BoxRegistration,
  cwd: string,
  containerPath: string,
  prompts: PendingPrompts,
  subscribers: PromptSubscribers,
): Promise<GitRpcResult> {
  if (!(await toolRequestsEnabled(cwd))) {
    return {
      exitCode: 65,
      stdout: '',
      stderr:
        'host-tool requests are disabled for this project ' +
        '(`agentbox config set --project tools.request.enabled true` to allow them)\n',
    };
  }
  const existing = await loadGrantedTools(cwd);
  if (existing.has(name)) {
    return { exitCode: 0, stdout: `${name} is already granted\n`, stderr: '' };
  }
  if (!(await hostToolInstalled(name))) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: `${name} is not installed on the host — nothing to grant\n`,
    };
  }
  const verdict = await askPrompt(prompts, subscribers, reg.boxId, {
    kind: 'confirm',
    message: `Box ${reg.name} requests access to the host CLI \`${name}\`. Grant it?`,
    detail: reason ? `reason: ${reason}` : 'no reason given',
    defaultAnswer: 'n',
    context: { command: `tool request ${name}`, cwd: containerPath, argv: [name] },
  });
  if (verdict.answer !== 'y') {
    return { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
  }
  await writeToolGrant(await resolveProjectToolsFile(cwd), {
    name,
    bin: name,
    source: 'request',
    approvedAt: new Date().toISOString(),
  });
  return {
    exitCode: 0,
    stdout: `${name} granted for this project\n`,
    stderr: '',
  };
}

/**
 * Park an outbound copy for a machine that is offline. Returns null when there
 * is nothing to park (no custody, nothing pulled, over the cap), in which case
 * the caller reports the plain unreachable error.
 */
async function parkOutboundCp(args: {
  params: CpRpcParams | undefined;
  reg: BoxRegistration;
  custody: CustodyStore | null;
  maxBytes: number;
  log: (line: string) => void;
}): Promise<GitRpcResult | null> {
  const { params, reg, custody, maxBytes, log } = args;
  if (!custody) return null;
  let norm: { sources: string[]; dest: string };
  try {
    norm = normalizeCpParams('cp.toHost', params);
  } catch {
    return null;
  }
  return parkCpOutbox(norm.sources, norm.dest, {
    custody,
    cliEntry: process.env.AGENTBOX_CLI_ENTRY,
    boxId: reg.boxId,
    boxName: reg.name,
    prefix: cpOutboxPrefix({
      projectSlug: reg.originUrl
        ? (projectSlugFromOriginUrl(reg.originUrl) ?? undefined)
        : undefined,
      boxId: reg.boxId,
    }),
    maxBytes,
    log,
  });
}

/**
 * Whether this machine still has the box's registered workspace on disk — the
 * test for "are the files here, or on someone else's machine?".
 *
 * A control box is not automatically the wrong place to run a copy. `agentbox
 * hub expose` turns the user's own laptop into the control box, and there the
 * workspace is right where the record says: parking a copy for a remote machine
 * that does not exist would break a flow that works today. On a VPS control box
 * the same check fails for both shapes that matter — a box created there records
 * the create job's temp clone, which the worker deletes, and a box created on a
 * PC records a path that never existed on the VPS — so those park.
 *
 * Existence rather than a flag, because that is literally the question: `cp`
 * spawns the CLI with this directory as its cwd, and a missing cwd is what
 * produced `spawn <node> ENOENT` on a live control box.
 */
async function boxWorkspaceExistsHere(boxId: string): Promise<boolean> {
  try {
    const path = await boxWorkspacePath(boxId);
    return typeof path === 'string' && path.length > 0 && existsSync(path);
  } catch {
    return false;
  }
}

/**
 * What a box is told when its `cp` could not reach the machine that holds the
 * files. Distinguishes the two ways that happens, because the fixes differ: a
 * machine that never connected needs starting, one that vanished mid-copy needs
 * the copy retried.
 *
 * Exit 69 (EX_UNAVAILABLE) rather than a generic 1, so an agent can tell "your
 * side is offline, try later" apart from "that path is wrong".
 */
function cpUnreachableMessage(
  method: CpMethod,
  boxName: string,
  reason: HostReachUnreachable,
  opts: { cacheMiss?: boolean } = {},
): string {
  const direction = method === 'cp.toHost' ? 'to' : 'from';
  const lead =
    reason === 'went-away'
      ? 'the machine holding these files stopped responding part-way through the copy'
      : 'the machine holding these files is not connected to this hub';
  return [
    `cp ${direction} the host could not run: ${lead}.`,
    // Naming BOTH facts matters: "offline" alone reads as "wait and retry",
    // when the fix for a cold cache is to pre-load the file instead.
    ...(opts.cacheMiss ? ['This hub has no cached copy of those paths either.'] : []),
    '',
    'This hub brokers the copy; it does not hold your project files.',
    `Start AgentBox on that machine (\`agentbox relay start\`) and retry, or run it there directly:`,
    `  agentbox cp ${boxName}:<src> <dst>`,
    ...(opts.cacheMiss
      ? [
          'To make a file readable with that machine offline, upload it there once:',
          '  agentbox cp <file> hub:',
        ]
      : []),
    '',
  ].join('\n');
}

/**
 * Serve a `cp.fromHost` from custody when the owning machine is offline, behind
 * the same approval a live copy gets — parked on this control box, so it can be
 * answered from the web UI or the tray with the laptop shut.
 *
 * Returns null when there is nothing cached (the caller then reports the
 * two-fact error) or when the user declines.
 */
async function serveCachedCp(args: {
  params: CpRpcParams | undefined;
  reg: BoxRegistration;
  custody: CustodyStore | null;
  cachePrefix: string;
  prompts: PendingPrompts;
  subscribers: PromptSubscribers;
  log: (line: string) => void;
}): Promise<GitRpcResult | null> {
  const { params, reg, custody, cachePrefix, prompts, subscribers, log } = args;
  if (!custody) return null;
  let sources: string[];
  try {
    sources = normalizeCpParams('cp.fromHost', params).sources;
  } catch {
    return null;
  }
  // The cache is keyed by the path the OWNING machine resolved, which is what
  // it stored; an absolute source is already that, and a relative one is
  // resolved against the box's workspace exactly as the live path does.
  const workspacePath = await boxWorkspacePath(reg.boxId);
  const resolved = sources.map((s) => resolveHostPath(workspacePath, s));
  const lookup = await lookupCpCache(resolved, { custody, cachePrefix });
  if (lookup.missing.length > 0) return null;

  const verdict = await askPrompt(prompts, subscribers, reg.boxId, {
    kind: 'confirm',
    message: `Allow ${reg.name} to read a CACHED copy of these files?`,
    detail: [
      'The machine holding them is offline; this hub has an older copy:',
      describeCpCacheEntries(lookup),
    ].join('\n'),
    defaultAnswer: 'n',
    context: { command: 'cp.fromHost (cached)', argv: resolved },
  });
  if (verdict.answer !== 'y') {
    return { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
  }
  return serveCpFromCache(params, resolved, {
    custody,
    cliEntry: process.env.AGENTBOX_CLI_ENTRY,
    boxName: reg.name,
    cachePrefix,
    log,
  });
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
async function handleCpRpc(cpArgs: string[], cwd?: string): Promise<GitRpcResult> {
  const entry = process.env.AGENTBOX_CLI_ENTRY;
  if (!entry) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: 'relay: AGENTBOX_CLI_ENTRY not set; cannot run cp host-side',
    };
  }
  // Re-shell the installed `agentbox cp` (it owns the tar pipe, excludes, the
  // size guard, and provider routing). `cpArgs` is the fully-built argv from
  // buildCpArgv (box side prefixed with `<name>:`, host paths absolute); `cwd`
  // (the box workspace) makes the host CLI's project-config lookup box-correct.
  const argv = [process.execPath, entry, ...cpArgs];
  return runHostCommand(argv, CP_RPC_TIMEOUT_MS, cwd);
}

/**
 * download.{workspace,env,config,claude}: ask the installed agentbox CLI
 * to pull box contents to the host. Same decoupling rationale as cp — the
 * CLI owns rsync exclude lists, gitignore handling, claude registry
 * merging. The relay passes `-y` so the host CLI doesn't try to prompt
 * (we already did, via the host wrapper, before reaching this handler).
 */
async function handleDownloadRpc(reg: BoxRegistration, kind: DownloadKind): Promise<GitRpcResult> {
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
  // Run from the box's host workspace so the host CLI's project-config lookup
  // is box-correct (the destination already defaults to box.workspacePath).
  const cwd = await boxWorkspacePath(reg.boxId);
  return runHostCommand(argv, DOWNLOAD_RPC_TIMEOUT_MS, cwd);
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
  cwd?: string,
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
      // Default to the relay daemon's CWD when unset (legacy behaviour); callers
      // that know the box pass its workspace so relative host paths + project
      // config resolve against the box, not whatever dir launched the relay.
      ...(cwd ? { cwd } : {}),
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
  // Hydrate the in-memory mirror from a durable store before the caller starts
  // the daemon loops, so a control box's registry/statusStore survive a restart
  // (no-op for the MemoryStore laptop path — it has no `hydrate`).
  if (handle.store instanceof WriteThroughStore) await handle.store.hydrate();
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
