/**
 * Host-initiated RPC tokens.
 *
 * `agentbox git <op> <box>` runs on the host but ultimately triggers a
 * credentialed RPC (`git.push`, `gh.pr.<op>`, …) on the host-side relay.
 * Those RPCs normally surface a y/N confirm prompt to the user — the box
 * (and the agent inside it) is untrusted, so every push/PR must be approved.
 *
 * For host-initiated calls, the user has already typed the command on the
 * host, so re-prompting is just friction. But "host-initiated" must not be
 * something the box can claim by setting a flag — a malicious agent could
 * trivially abuse that. So instead the host CLI:
 *
 *   1. Computes a `paramsHash` of the exact params it's about to send.
 *   2. Mints a one-time token via the relay's loopback-only admin endpoint
 *      `POST /admin/host-initiated/mint`, scoped to `(boxId, method, paramsHash)`.
 *   3. Passes the token to `agentbox-ctl` (via `--host-initiated-token`),
 *      which forwards it in `params.hostInitiated` on the RPC.
 *   4. The relay re-hashes the incoming params (excluding `hostInitiated`),
 *      compares against the minted hash, and only skips the prompt on a
 *      full `(boxId, method, paramsHash)` match. The token is then consumed.
 *
 * Tokens are 32 random bytes (256 bits — collision/guessing safety), expire
 * after ~120s, and are one-shot.
 *
 * Failure-mode policy (enforced at each call site, not here):
 *
 *   - `params.hostInitiated` absent → no token claimed; the RPC falls
 *     through to the normal askPrompt path (the agent-initiated default).
 *   - `params.hostInitiated` present but `consume()` returns false →
 *     **reject the RPC outright** (exit code 10). The only way to obtain a
 *     token is via the loopback-only mint endpoint; a token that doesn't
 *     validate (wrong scope, mutated params, replayed, expired) is an
 *     attack signal. Falling through to the prompt would (a) leak that the
 *     attacker has a token, (b) bait the user into approving a call they
 *     didn't initiate. Hard reject.
 *
 * ## Threat model
 *
 * The mint endpoint is loopback-only, so a box cannot mint its own tokens
 * (boxes see the relay on `host.docker.internal` or via cloud bridges,
 * never 127.0.0.1).
 *
 * The token is delivered to the box via `docker exec --argv agentbox-ctl …
 * --host-initiated-token <tok>`. /proc/<pid>/cmdline is world-readable on
 * Linux, so a malicious in-box process polling /proc COULD harvest the
 * token while agentbox-ctl is running. Without paramsHash binding the
 * attacker could then send their own RPC with the same token but *modified
 * args* (`--force` on push, altered `--title`/`--body` on PR create) and
 * win a race against the legit caller. paramsHash binding closes that gap:
 * the relay rejects any incoming params that don't hash to the minted hash,
 * so harvested tokens are only good for the exact params the host CLI
 * already authorized.
 *
 * Optional `paramsHash === undefined` mode exists for forward compatibility
 * (callers that don't need params binding); the production callers
 * (`agentbox git`) always pass a hash.
 */

import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 120_000;

interface TokenRecord {
  boxId: string;
  method: string;
  /**
   * Hex SHA-256 of the canonicalized params the host CLI committed to
   * sending. Verified against the incoming `/rpc` params in `consume()`.
   * `null` means "no params binding" — only safe for calls where the
   * params surface is fully host-controlled (none in practice today).
   */
  paramsHash: string | null;
  expiresAt: number;
}

/**
 * Compute a stable SHA-256 of the JSON params, with keys sorted and the
 * `hostInitiated` field stripped (so the token-bearing call hashes the same
 * as the at-mint-time intended params). Stable hash regardless of key order
 * in the wire payload, regardless of whether `hostInitiated` is set.
 */
export function hashRpcParams(params: unknown): string {
  return createHash('sha256').update(canonicalJson(params)).digest('hex');
}

function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'undefined') return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([k]) => k !== 'hostInitiated')
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      '{' +
      entries.map(([k, val]) => JSON.stringify(k) + ':' + canonicalJson(val)).join(',') +
      '}'
    );
  }
  return 'null';
}

export class HostInitiatedTokens {
  private readonly store = new Map<string, TokenRecord>();

  /**
   * Mint a fresh one-time token scoped to (boxId, method, paramsHash).
   * `paramsHash` MUST be supplied for any call surface where the box can
   * influence the eventual RPC params. Pass `null` only when there are no
   * params (no current call sites use this).
   */
  mint(
    boxId: string,
    method: string,
    paramsHash: string | null,
    ttlMs: number = DEFAULT_TTL_MS,
  ): string {
    const token = randomBytes(32).toString('hex');
    this.store.set(token, { boxId, method, paramsHash, expiresAt: Date.now() + ttlMs });
    return token;
  }

  /**
   * Returns true exactly once if `token` is a valid, unexpired token for the
   * given `(boxId, method)` AND the supplied `incomingParamsHash` matches
   * the hash bound at mint time. The token is removed on a successful match
   * (one-shot semantics). All failure modes return false — callers fall back
   * to the normal prompt path.
   */
  consume(
    token: string | undefined,
    boxId: string,
    method: string,
    incomingParamsHash: string,
  ): boolean {
    if (!token || typeof token !== 'string') return false;
    const record = this.store.get(token);
    if (!record) return false;
    if (record.expiresAt < Date.now()) {
      this.store.delete(token);
      return false;
    }
    if (record.boxId !== boxId || record.method !== method) return false;
    // paramsHash null = "no binding"; otherwise enforce exact match.
    if (record.paramsHash !== null && record.paramsHash !== incomingParamsHash) {
      return false;
    }
    this.store.delete(token);
    return true;
  }

  /** Drop expired entries. Cheap; safe to call periodically. */
  gc(): void {
    const now = Date.now();
    for (const [token, record] of this.store) {
      if (record.expiresAt < now) this.store.delete(token);
    }
  }

  /** Test-only: number of live tokens. */
  size(): number {
    return this.store.size;
  }
}
