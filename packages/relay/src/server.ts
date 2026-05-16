import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BoxRegistry, EventBuffer } from './registry.js';
import { BoxStatusStore, isValidBoxStatus } from './status-store.js';
import type {
  BoxRegistration,
  BoxWorktree,
  GitRpcParams,
  GitRpcResult,
  PostEventBody,
  PostRpcBody,
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
  url: string;
  close: () => Promise<void>;
}

/** Event type whose payload is a durable BoxStatus snapshot (persisted, not ringed). */
const BOX_STATUS_EVENT = 'box-status';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB hard cap; relay is for control-plane traffic, not payloads.
const GIT_RPC_TIMEOUT_MS = 120_000; // git push/pull can be slow on big repos.

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
 *   POST /rpc                   — bearer auth; dispatches git.pull / git.push on the host.
 *   POST /admin/register-box    — loopback only.
 *   POST /admin/forget-box      — loopback only.
 *   GET  /admin/box-status      — loopback only; query `box`; latest snapshot.
 *   GET  /admin/events          — loopback only; query `box`, `since`.
 *   GET  /admin/registry        — loopback only; list registered boxes (token redacted).
 *   GET  /healthz               — liveness probe (no auth).
 */
export function createRelayServer(opts: RelayServerOptions): RelayServerHandle {
  const log = opts.logger ?? (() => {});
  const registry = new BoxRegistry();
  const events = new EventBuffer();
  const statusStore = new BoxStatusStore();
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
        await statusStore.set(reg.boxId, body.payload);
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
      if (body.method === 'git.pull' || body.method === 'git.push') {
        const result = await handleGitRpc(reg, body.method, body.params as GitRpcParams | undefined);
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
        worktrees: r.worktrees ?? [],
      }));
      send(res, 200, { boxes: redacted });
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
      typeof w.hostWorktreeDir === 'string' &&
      typeof w.branch === 'string'
    ) {
      out.push({
        containerPath: w.containerPath,
        hostWorktreeDir: w.hostWorktreeDir,
        branch: w.branch,
      });
    }
  }
  return out;
}

/**
 * Resolve `params.path` (a path inside the container) to the host worktree
 * directory the relay should run git in. `/workspace` always maps to the root
 * worktree; `/workspace/<sub>` maps to a nested worktree when one is
 * registered for that subpath, otherwise falls back to the root.
 */
function resolveWorktree(reg: BoxRegistration, containerPath: string): BoxWorktree | null {
  const trees = reg.worktrees ?? [];
  if (trees.length === 0) return null;
  const exact = trees.find((w) => w.containerPath === containerPath);
  if (exact) return exact;
  // Longest containerPath prefix wins so /workspace/app/sub picks /workspace/app if registered.
  const prefixMatches = trees
    .filter((w) => containerPath === w.containerPath || containerPath.startsWith(w.containerPath + '/'))
    .sort((a, b) => b.containerPath.length - a.containerPath.length);
  return prefixMatches[0] ?? trees.find((w) => w.containerPath === '/workspace') ?? null;
}

async function handleGitRpc(
  reg: BoxRegistration,
  method: 'git.pull' | 'git.push',
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
  const op = method === 'git.pull' ? 'pull' : 'push';
  const remote = params?.remote ?? 'origin';
  const argv = ['git', '-C', worktree.hostWorktreeDir, op, remote];
  if (Array.isArray(params?.args)) {
    for (const a of params.args) {
      if (typeof a === 'string') argv.push(a);
    }
  }
  return runHostCommand(argv);
}

function runHostCommand(argv: string[]): Promise<GitRpcResult> {
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
      stderr += `\nrelay: command timed out after ${String(GIT_RPC_TIMEOUT_MS)}ms\n`;
      finish(124);
    }, GIT_RPC_TIMEOUT_MS);
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
