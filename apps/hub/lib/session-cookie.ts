// Crypto-only classification of a request's better-auth cookies, for the gate in
// `proxy.ts`. This is the ONLY better-auth surface the middleware bundle touches
// beyond `getSessionCookie`, which it already imported: `better-auth/cookies`
// pulls in jose / @noble/hashes and nothing else — no auth instance, no database
// driver. Keeping the driver out of the middleware bundle is deliberate (see the
// note in `session-gate.ts`).
import { getCookieCache, getSessionCookie } from 'better-auth/cookies';

/** What inspecting the request's cookies proved WITHOUT touching the session store. */
export type CookieEvidence =
  /** No better-auth session cookie at all — deny, and don't bother the session store. */
  | { kind: 'absent' }
  /**
   * A session token cookie is present, but the signed session-data cookie is
   * missing, forged, expired or undecodable. Says NOTHING about validity: the
   * token cookie is unsigned as far as this check goes, so the caller must go on
   * to the authoritative probe. Never treat this as authorized.
   */
  | { kind: 'unverified' }
  /** The signed session-data cookie verified against the secret and has not expired. */
  | { kind: 'cached'; sessionExpiresAt: number };

/** The one field of the decoded `{ session, user }` payload the gate reads. */
function expiresAtOf(payload: unknown): string | number | Date | undefined {
  const session = (payload as { session?: { expiresAt?: unknown } } | null)?.session;
  const raw = session?.expiresAt;
  return typeof raw === 'string' || typeof raw === 'number' || raw instanceof Date
    ? raw
    : undefined;
}

/**
 * Classify the request's cookies with cryptography alone.
 *
 * `getCookieCache` verifies the `session_data` cookie's HMAC against the hub's
 * `BETTER_AUTH_SECRET` and rejects on both the cache's own `expiresAt` and the
 * session's embedded one — a real check, not a presence check, and it costs no
 * I/O. A hit lets the gate authorize for the cookie-cache window without asking
 * the session store.
 *
 * Both `__Secure-`-prefixed and bare cookie names are tried. The prefix is NOT
 * `cookieSecure()`: better-auth's own `useSecureCookies` default (which follows
 * `NODE_ENV`) picks the name, and it overrides `advanced.defaultCookieAttributes`
 * — a production hetzner hub issues `__Secure-better-auth.session_data` even
 * though `cookieSecure()` is false. Guessing the wrong name is a silent permanent
 * cache miss (a probe on every single request), so probe for it instead.
 *
 * Never throws: `getCookieCache` raises when the secret is unset, and an
 * undecodable cookie is attacker-controlled input. Every failure degrades to
 * `unverified`, which forces the authoritative check rather than allowing.
 *
 * Known window, inherited from better-auth's own `session.cookieCache` and no
 * wider than it: a session revoked by sign-out stays authorized for whatever is
 * left of the cache cookie's 5 minutes. better-auth's own `getSession` trusts the
 * same cookie, and sign-out deletes it in the browser, so only a *stolen* cookie
 * can replay — and only until it lapses. Shrinking the window means shrinking
 * `cookieCache.maxAge` in `auth.ts`, not special-casing it here.
 */
export async function readCookieEvidence(
  headers: Headers,
  opts: { secret: string | undefined; secureCookies: boolean },
): Promise<CookieEvidence> {
  if (!getSessionCookie(headers)) return { kind: 'absent' };
  const secret = opts.secret;
  if (!secret) return { kind: 'unverified' };

  // Most-likely name first, then the other one.
  for (const isSecure of [opts.secureCookies, !opts.secureCookies]) {
    let payload: unknown = null;
    try {
      payload = await getCookieCache(headers, { secret, isSecure });
    } catch {
      continue;
    }
    const raw = expiresAtOf(payload);
    if (raw == null) continue;
    const expiresAt = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
    if (!Number.isFinite(expiresAt)) continue;
    return { kind: 'cached', sessionExpiresAt: expiresAt };
  }
  return { kind: 'unverified' };
}
