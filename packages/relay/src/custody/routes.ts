/**
 * The custody HTTP surface, as a framework-agnostic dispatcher mounted by BOTH
 * relay front-ends: the hosted-plane handler (`core/handler.ts`, Next) and the
 * relay daemon (`server.ts`, node:http — what the control box actually runs).
 * One implementation, one gate, both profiles.
 *
 * Gating is the caller's job with one hard rule, enforced here rather than by
 * each host router: **the admin bearer is the only proof**. `server.ts` treats
 * loopback as admin, but on the control box the hub sits behind Caddy on the
 * same host, so every proxied request looks loopback — accepting that here
 * would publish the credential store. Missing admin token or missing custody
 * store → 503 (not configured); wrong token → 401.
 *
 * Values never appear in a log line: only path, size, and the changed flag.
 */

import { timingSafeEqual } from 'node:crypto';
import { CustodyPathError, normalizeCustodyPath, normalizeCustodyPrefix, type CustodyStore } from './store.js';

/** Structurally identical to `RelayResponse` in `core/handler.ts` (kept local to avoid a cycle). */
export interface CustodyResponse {
  status: number;
  body?: unknown;
}

export interface CustodyRequest {
  method: string;
  /** URL pathname, e.g. `/admin/custody/agents/claude/.credentials.json`. */
  path: string;
  query: URLSearchParams;
  /** Bearer token as presented ('' when absent). */
  bearer: string;
  /** Raw request body ('' for GET/DELETE). */
  bodyText: string;
}

export interface CustodyRouteDeps {
  /** Wired by the control box / hub. Absent → custody is not enabled here (503). */
  custody?: CustodyStore | null;
  /** Admin bearer. Empty/absent → custody is not configured (503). */
  adminToken?: string;
  log?: (line: string) => void;
}

export const CUSTODY_PATH_PREFIX = '/admin/custody';

/** True when `path` addresses the custody surface (so a router can dispatch it here). */
export function isCustodyPath(path: string): boolean {
  return path === CUSTODY_PATH_PREFIX || path.startsWith(`${CUSTODY_PATH_PREFIX}/`);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Dispatch one custody request. Returns `null` when `req.path` is not a custody
 * path, so a host router can fall through to its own routes unchanged.
 */
export async function handleCustodyRequest(
  req: CustodyRequest,
  deps: CustodyRouteDeps,
): Promise<CustodyResponse | null> {
  if (!isCustodyPath(req.path)) return null;
  const log = deps.log ?? (() => {});

  const adminToken = deps.adminToken ?? '';
  if (adminToken.length === 0) {
    return { status: 503, body: { error: 'custody not configured: admin token unset' } };
  }
  if (!timingSafeEqualStr(req.bearer, adminToken)) {
    return { status: 401, body: { error: 'invalid admin token' } };
  }
  const store = deps.custody;
  if (!store) {
    return { status: 503, body: { error: 'custody store not enabled on this relay' } };
  }

  try {
    if (req.path === CUSTODY_PATH_PREFIX) {
      if (req.method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };
      const rawPrefix = req.query.get('prefix');
      const prefix = rawPrefix ? normalizeCustodyPrefix(rawPrefix) : undefined;
      const entries = await store.list(prefix);
      return { status: 200, body: { entries } };
    }

    const path = normalizeCustodyPath(
      decodeURIComponent(req.path.slice(`${CUSTODY_PATH_PREFIX}/`.length)),
    );

    if (req.method === 'PUT') {
      let parsed: { data?: unknown };
      try {
        parsed = JSON.parse(req.bodyText.length === 0 ? '{}' : req.bodyText) as { data?: unknown };
      } catch {
        return { status: 400, body: { error: 'expected JSON {data: <base64>}' } };
      }
      if (typeof parsed.data !== 'string') {
        return { status: 400, body: { error: 'expected {data: <base64>}' } };
      }
      const buf = Buffer.from(parsed.data, 'base64');
      // base64 decoding is lenient (it drops junk rather than throwing), so
      // round-trip it: a value that doesn't re-encode identically was not
      // base64 and would be stored silently truncated.
      if (buf.toString('base64') !== parsed.data.replace(/\s+/g, '')) {
        return { status: 400, body: { error: 'data is not valid base64' } };
      }
      const result = await store.put(path, buf);
      log(
        `custody put ${path} (${String(result.size)} bytes, ${result.changed ? 'changed' : 'unchanged'})`,
      );
      return { status: 200, body: result };
    }

    if (req.method === 'GET') {
      const found = await store.get(path);
      if (!found) return { status: 404, body: { error: 'no such custody entry' } };
      log(`custody get ${path} (${String(found.entry.size)} bytes)`);
      return { status: 200, body: { ...found.entry, data: found.data.toString('base64') } };
    }

    if (req.method === 'DELETE') {
      const hit = await store.delete(path);
      if (!hit) return { status: 404, body: { error: 'no such custody entry' } };
      log(`custody delete ${path}`);
      return { status: 204 };
    }

    return { status: 405, body: { error: 'method not allowed' } };
  } catch (err) {
    if (err instanceof CustodyPathError) return { status: 400, body: { error: err.message } };
    const msg = err instanceof Error ? err.message : String(err);
    log(`custody error: ${msg}`);
    return { status: 500, body: { error: `custody: ${msg}` } };
  }
}
