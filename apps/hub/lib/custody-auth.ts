// The custody two-tier auth contract, extracted pure so it is unit-testable and a
// refactor of the route can't silently drop it (see the test — an API-key-only
// caller MUST NOT be able to read bytes).
//
// Custody holds agent credentials, `.env` files, and — the highest-value target in
// the whole API — per-box SSH PRIVATE KEYS. list/PUT/DELETE authorize with the hub
// API key alone and return metadata only; a byte-read (GET a stored value) is the
// ONE route that returns bytes, so it needs a SECOND, non-distributed credential.
import { timingSafeEqual } from 'node:crypto';

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Whether a byte-read may return the stored value, given the request context. The
 * enforcement point of the two-tier contract.
 *
 * - `password` profile (a real / exposed control box): FAIL CLOSED. Only a valid
 *   admin token (`AGENTBOX_RELAY_ADMIN_TOKEN`, presented as `X-Agentbox-Admin-Token`)
 *   authorizes. A missing/empty/mismatched header — or an unset admin-token env —
 *   is refused. The hub API key travels to the tray / web / thin clients, so it must
 *   never be enough to read a value.
 * - `token` profile (a plain local hub): the request already passed the proxy's hub
 *   token gate, and that token is a machine-local secret (not distributed like the
 *   API key), so it is itself the elevated credential — no second token needed.
 * - `off`: the operator disabled all auth; the whole API is open, so byte-reads are
 *   too (nothing to "degrade to" — there is no API key gate to bypass).
 *
 * list/PUT/DELETE never call this: they stay API-key-gated with metadata-only
 * responses regardless of the admin token.
 */
export function custodyByteReadAuthorized(args: {
  mode: 'off' | 'token' | 'password';
  /** `process.env.AGENTBOX_RELAY_ADMIN_TOKEN` (or '' when unset). */
  adminToken: string;
  /** The `X-Agentbox-Admin-Token` header value (or '' when absent). */
  providedToken: string;
}): boolean {
  if (args.mode !== 'password') return true;
  if (args.adminToken.length === 0) return false;
  if (args.providedToken.length === 0) return false;
  return timingSafeEqualStr(args.providedToken, args.adminToken);
}
