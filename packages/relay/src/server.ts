import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { askPrompt, isPromptAnswerBody, PendingPrompts, PromptSubscribers } from './prompts.js';
import { BoxRegistry, EventBuffer } from './registry.js';
import { BoxStatusStore, isValidBoxStatus } from './status-store.js';
import type {
  BoxRegistration,
  BoxWorktree,
  CheckpointRpcParams,
  CpRpcParams,
  DownloadKind,
  DownloadRpcParams,
  GitRpcParams,
  GitRpcResult,
  PostEventBody,
  PostRpcBody,
  PromptAnswerBody,
  RegisterBoxBody,
  RelayEvent,
} from './types.js';

export interface RelayServerOptions {
  port: number;
  /** Bind address; defaults to '0.0.0.0' so the container reachable from other containers on the same docker network. */
  host?: string;
  logger?: (line: string) => void;
}

export interface RelayServerHandle {
  server: Server;
  registry: BoxRegistry;
  events: EventBuffer;
  statusStore: BoxStatusStore;
  prompts: PendingPrompts;
  subscribers: PromptSubscribers;
  url: string;
  close: () => Promise<void>;
}

/** Event type whose payload is a durable BoxStatus snapshot (persisted, not ringed). */
const BOX_STATUS_EVENT = 'box-status';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB hard cap; relay is for control-plane traffic, not payloads.
const GIT_RPC_TIMEOUT_MS = 120_000; // git push/pull can be slow on big repos.
const CHECKPOINT_RPC_TIMEOUT_MS = 600_000; // capturing node_modules/build trees can be slow.
const DOWNLOAD_RPC_TIMEOUT_MS = 600_000; // claude/workspace pulls over rsync can take minutes.
const CP_RPC_TIMEOUT_MS = 300_000; // single-file/dir cp; tar pipe through docker exec.
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

/**
 * Build the relay HTTP server. Routes:
 *   POST /events                — bearer auth (box token), appends to ring buffer.
 *   POST /rpc                   — bearer auth; dispatches git.push/fetch, cp.*, download.*, checkpoint.create on the host.
 *   POST /admin/register-box    — loopback only.
 *   POST /admin/forget-box      — loopback only.
 *   GET  /admin/box-status      — loopback only; query `box`; latest snapshot.
 *   GET  /admin/events          — loopback only; query `box`, `since`.
 *   GET  /admin/registry        — loopback only; list registered boxes (token redacted).
 *   GET  /admin/prompts/stream  — loopback only; SSE; pushes prompt-ask/prompt-resolved/ping events.
 *   POST /admin/prompts/answer  — loopback only; resolves a pending prompt by id.
 *   GET  /healthz               — liveness probe (no auth).
 */
export function createRelayServer(opts: RelayServerOptions): RelayServerHandle {
  const log = opts.logger ?? (() => {});
  const registry = new BoxRegistry();
  const events = new EventBuffer();
  const statusStore = new BoxStatusStore();
  const prompts = new PendingPrompts();
  const subscribers = new PromptSubscribers();
  const host = opts.host ?? '0.0.0.0';

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
      send(res, 200, { ok: true, boxes: registry.size(), events: events.size() });
      return;
    }

    // Admin endpoints are reachable from loopback only. The relay binds to
    // 0.0.0.0 so containers can reach /events and /rpc via host.docker.internal,
    // but admin operations (register-box, forget-box, list events, etc.) are
    // for the host CLI and must not be exposed to boxes.
    if (url.pathname.startsWith('/admin/')) {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        send(res, 403, { error: 'admin endpoints are loopback-only' });
        return;
      }
    }

    if (route === 'POST /events') {
      const reg = authBox(req, res, registry);
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
        await statusStore.set(reg.boxId, reg.name, reg.projectIndex, body.payload);
        log(`box-status box=${reg.boxId}`);
        send(res, 202, { ok: true });
        return;
      }
      const ev = events.append({
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
      const reg = authBox(req, res, registry);
      if (!reg) return;
      const body = await readJsonBody<PostRpcBody>(req);
      if (!body || typeof body.method !== 'string' || body.method.length === 0) {
        send(res, 400, { error: 'missing "method" string' });
        return;
      }
      log(`rpc box=${reg.boxId} method=${body.method}`);
      if (body.method === 'git.push' || body.method === 'git.fetch') {
        // Only `push` mutates the user's remote; fetch is read-only and noisy.
        if (body.method === 'git.push') {
          const params = body.params as GitRpcParams | undefined;
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
        const direction = body.method === 'cp.toHost' ? 'box -> host' : 'host -> box';
        const verdict = await askPrompt(prompts, subscribers, reg.boxId, {
          kind: 'confirm',
          message: `Allow cp (${direction}) on ${reg.name}?`,
          detail:
            body.method === 'cp.toHost'
              ? `${params.boxPath} -> ${params.hostPath}`
              : `${params.hostPath} -> ${params.boxPath}`,
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
      events.append({
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
      const reg: BoxRegistration = {
        boxId: body.boxId,
        token: body.token,
        name: body.name,
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
      };
      registry.register(reg);
      log(
        `registered box ${reg.boxId} (${reg.name})` +
          (worktrees && worktrees.length > 0 ? ` with ${String(worktrees.length)} worktree(s)` : ''),
      );
      send(res, 204, null);
      return;
    }

    if (route === 'POST /admin/forget-box') {
      const body = await readJsonBody<{ boxId?: string }>(req);
      if (!body || typeof body.boxId !== 'string' || body.boxId.length === 0) {
        send(res, 400, { error: 'expected {boxId}' });
        return;
      }
      const existed = registry.forget(body.boxId);
      statusStore.delete(body.boxId);
      log(`forgot box ${body.boxId} (existed=${String(existed)})`);
      send(res, 204, null);
      return;
    }

    if (route === 'GET /admin/box-status') {
      const box = url.searchParams.get('box') ?? '';
      const status = box ? statusStore.get(box) : undefined;
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
      const list = events.since(since, box ?? undefined);
      send(res, 200, { events: list });
      return;
    }

    if (route === 'GET /admin/registry') {
      // Redact tokens; callers on the admin path don't need them and we don't
      // want them showing up in logs if someone curls this.
      const redacted = registry.list().map((r) => ({
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

    send(res, 404, { error: 'not found', route });
  }

  function authBox(
    req: IncomingMessage,
    res: ServerResponse,
    reg: BoxRegistry,
  ): BoxRegistration | null {
    const token = bearerToken(req);
    if (token.length === 0) {
      send(res, 401, { error: 'missing bearer token' });
      return null;
    }
    const match = reg.authenticate(token);
    if (!match) {
      send(res, 401, { error: 'unknown box token' });
      return null;
    }
    return match;
  }

  return {
    server,
    registry,
    events,
    statusStore,
    prompts,
    subscribers,
    url: `http://${host}:${String(opts.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
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
  return runHostCommand(argv);
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
  const argv =
    method === 'cp.toHost'
      ? [process.execPath, entry, 'cp', boxRef, params.hostPath]
      : [process.execPath, entry, 'cp', params.hostPath, boxRef];
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
