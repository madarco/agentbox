/**
 * The `/admin/store` generic-Store RPC surface, as a framework-agnostic
 * dispatcher mounted by BOTH relay front-ends: the hosted-plane handler
 * (`core/handler.ts`, Next/Vercel) and the relay daemon (`server.ts`, node:http
 * — what the control box actually runs). One implementation, one gate, both
 * profiles, so a PC's {@link RemoteStore} works against the control box exactly
 * as against the hosted plane.
 *
 * Like custody / remote-boxes, the **admin bearer is the only proof** — never
 * loopback (the control box sits behind Caddy on the same host, so every proxied
 * request looks loopback). Missing admin token → 503 (not configured); wrong
 * token → 401. The method name is an explicit allow-list ({@link isStoreRpcMethod}),
 * so the endpoint can never invoke an arbitrary property of the store object.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Store } from './store.js';
import { applyStoreOp, isStoreRpcMethod, type StoreRpcRequest } from './store-rpc.js';

/** Structurally identical to `RelayResponse` in `core/handler.ts` (kept local to avoid a cycle). */
export interface StoreRpcRouteResponse {
  status: number;
  body?: unknown;
}

export interface StoreRpcRouteRequest {
  method: string;
  /** URL pathname, e.g. `/admin/store`. */
  path: string;
  /** Bearer token as presented ('' when absent). */
  bearer: string;
  /** Raw request body ('' for GET). */
  bodyText: string;
}

export interface StoreRpcRouteDeps {
  store: Store;
  /** Admin bearer. Empty/absent → not configured (503). */
  adminToken?: string;
  log?: (line: string) => void;
}

export const STORE_RPC_PATH = '/admin/store';

/** True when `path` addresses the generic-Store RPC surface. */
export function isStoreRpcPath(path: string): boolean {
  return path === STORE_RPC_PATH;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function parseJson<T>(text: string): T | null {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Dispatch one `/admin/store` request. Returns `null` when `req.path` is not the
 * store-RPC path, so a host router falls through to its own routes unchanged.
 */
export async function handleStoreRpcRequest(
  req: StoreRpcRouteRequest,
  deps: StoreRpcRouteDeps,
): Promise<StoreRpcRouteResponse | null> {
  if (!isStoreRpcPath(req.path)) return null;
  const adminToken = deps.adminToken ?? '';
  if (adminToken.length === 0) {
    return { status: 503, body: { error: 'control plane not configured: admin token unset' } };
  }
  if (!timingSafeEqualStr(req.bearer, adminToken)) {
    return { status: 401, body: { error: 'invalid admin token' } };
  }
  if (req.method !== 'POST') {
    return { status: 405, body: { error: 'method not allowed' } };
  }
  const body = parseJson<StoreRpcRequest>(req.bodyText);
  if (!body || typeof body.method !== 'string' || !Array.isArray(body.args)) {
    return { status: 400, body: { error: 'expected {method, args}' } };
  }
  if (!isStoreRpcMethod(body.method)) {
    return { status: 400, body: { error: `unknown store op: ${body.method}` } };
  }
  const result = await applyStoreOp(deps.store, body.method, body.args);
  return { status: 200, body: { result: result ?? null } };
}
