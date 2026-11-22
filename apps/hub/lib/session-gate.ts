// The hub's authorization decision, extracted pure so it is unit-testable and a
// refactor of `proxy.ts` can't silently unmake it — same contract as
// `custody-auth.ts`, and for the same reason: this single function is the ONLY
// thing standing between the public internet and a control box that holds agent
// credentials, per-box SSH private keys and the owner's git token. Not one of the
// ~80 `/api/v1` route handlers does an identity check of its own.
//
// `proxy.ts` is the I/O shell around it: it reads env and cookies, runs the
// crypto in `session-cookie.ts`, performs the authoritative probe when this
// function asks for one, and renders the outcome.
import type { CookieEvidence } from './session-cookie';

export type { CookieEvidence };

/** The gate's view of `authMode()`. */
export type GateMode = 'off' | 'token' | 'password' | 'locked';

/**
 * Which answer shape the caller can use. `api` (the `/api/v1` REST surface and
 * the `/api/events` SSE stream) must get a JSON 401 — a headless client (the tray
 * or the CLI against a control box) cannot follow a `/signin` redirect.
 */
export type GateSurface = 'api' | 'page';

/**
 * The authoritative `/api/auth/get-session` check. `skipped` means it has not run
 * yet — the first pass through {@link gateOutcome} always passes `skipped` and
 * may come back asking for `probe`.
 *
 * `error` (non-2xx, a throw, a timeout) is deliberately NOT distinguished from
 * `invalid` in the outcome: an unreachable or unmigrated session store must deny.
 */
export type ProbeResult = 'valid' | 'invalid' | 'error' | 'skipped';

export interface GateInput {
  mode: GateMode;
  surface: GateSurface;
  /** `/api/v1/health`, `/api/v1/openapi.json`, `/api/v1/docs` — no state, never gated. */
  publicPath: boolean;
  /** password profile: `Authorization: Bearer` matched `AGENTBOX_HUB_API_KEY`. */
  bearerApiKeyOk: boolean;
  /**
   * password profile: the Bearer is an enrolled, unrevoked device's token — the id
   * server.ts verified and stamped. Undefined when it is not (or on vercel, which
   * has no server.ts to stamp it).
   */
  deviceId?: string;
  /** token profile: the bearer, the `?token=` query or the token cookie matched `AGENTBOX_HUB_TOKEN`. */
  hubTokenOk: boolean;
  /** token profile: the match came from the URL, so the cookie still has to be set. */
  hubTokenFromQuery: boolean;
  evidence: CookieEvidence;
  probe: ProbeResult;
  now: number;
}

export type GateOutcome =
  | { kind: 'allow' }
  /** Run the authoritative probe and call {@link gateOutcome} again with its result. */
  | { kind: 'probe' }
  | { kind: 'api-401' }
  | { kind: 'signin-redirect' }
  /** token profile, page surface: the plaintext "open it with `agentbox hub`" 401. */
  | { kind: 'token-locked' }
  /** token profile, page surface: `?token=` matched — set the cookie, redirect to the clean URL. */
  | { kind: 'token-handshake' }
  /** A deployed profile with no `BETTER_AUTH_SECRET`: 503, never an open hub. */
  | { kind: 'misconfigured' };

function deny(mode: GateMode, surface: GateSurface): GateOutcome {
  if (surface === 'api') return { kind: 'api-401' };
  return mode === 'token' ? { kind: 'token-locked' } : { kind: 'signin-redirect' };
}

/**
 * Decide a request. Pure: no I/O, no env reads, no clock.
 *
 * The load-bearing invariant, which the tests state as such: a *present* session
 * cookie is never enough. Only `evidence.kind === 'cached'` (an HMAC verified
 * against `BETTER_AUTH_SECRET`, unexpired) or `probe === 'valid'` (the session
 * store said yes) authorizes a cookie-bearing caller. Everything else — a forged
 * cookie, an expired one, a signed-out one, a session store that is down or not
 * yet migrated — denies.
 */
export function gateOutcome(i: GateInput): GateOutcome {
  if (i.mode === 'off') return { kind: 'allow' };
  // No signing secret on a deployed profile: refuse to serve rather than fall back
  // to an open hub. `AGENTBOX_HUB_AUTH=off` is the explicit, documented opt-out and
  // arrives here as `off` above.
  if (i.mode === 'locked') return { kind: 'misconfigured' };
  if (i.publicPath && i.surface === 'api') return { kind: 'allow' };

  if (i.mode === 'token') {
    // The `?token=` handshake is a page-only flow (an API client sends a Bearer).
    if (i.hubTokenOk && i.hubTokenFromQuery && i.surface === 'page')
      return { kind: 'token-handshake' };
    if (i.hubTokenOk) return { kind: 'allow' };
    return deny(i.mode, i.surface);
  }

  // password profile (hetzner / digitalocean / vercel).
  //
  // The headless Bearer key is checked before any cookie work: the tray and the
  // remote CLI live on this path, and it must cost nothing. It gates `/api/v1`
  // only — a leaked key still cannot reach the UI, since the page surface falls
  // through to the session check below.
  if (i.surface === 'api' && i.bearerApiKeyOk) return { kind: 'allow' };
  // A device token is the same kind of credential, per PC and revocable — and,
  // like the key, it never opens the UI.
  if (i.surface === 'api' && i.deviceId) return { kind: 'allow' };

  // No cookie at all: deny without probing, so unauthenticated traffic can never
  // amplify into session-store lookups.
  if (i.evidence.kind === 'absent') return deny(i.mode, i.surface);

  if (i.probe === 'valid') return { kind: 'allow' };
  if (i.probe === 'invalid' || i.probe === 'error') return deny(i.mode, i.surface);

  // probe === 'skipped' — first pass. A verified, unexpired cache cookie answers
  // without touching the session store; anything else escalates.
  if (i.evidence.kind === 'cached' && i.evidence.sessionExpiresAt > i.now) return { kind: 'allow' };
  return { kind: 'probe' };
}

/**
 * Where the middleware calls its own `/api/auth/get-session`.
 *
 * Embedded profiles use loopback on the hub's own port, NOT the request's origin:
 * behind Caddy the origin is the public https name, so authorizing a request would
 * depend on the VPS resolving its own DNS and trusting its own certificate, and
 * every failure there is a fail-closed total lockout. The deploy already health-checks
 * `http://127.0.0.1:<port>` from inside the VPS, so loopback is load-bearing anyway.
 *
 * Vercel has no single long-lived process to loop back to, so the request's origin
 * is the only option there.
 */
export function sessionProbeOrigin(a: {
  profile: 'localhost' | 'hetzner' | 'vercel';
  requestOrigin: string;
  hubPort: string | undefined;
}): string {
  if (a.profile === 'vercel') return a.requestOrigin;
  const port = Number.parseInt(a.hubPort ?? '', 10);
  return `http://127.0.0.1:${String(Number.isInteger(port) && port > 0 ? port : 8787)}`;
}

/**
 * Who an allowed request is, for the routes: stamped by the gate as
 * `x-agentbox-actor` (overwriting any client copy). `device:<id>` is a PC holding
 * its own token; `api-key` the operator's shared key; `session` a browser signed
 * in with the password; `hub-token` the local single-PC hub; `open` auth is off;
 * `anonymous` a public path. Stage 2 adds a user next to the device.
 */
export type GateActor =
  | `device:${string}`
  | 'api-key'
  | 'session'
  | 'hub-token'
  | 'open'
  | 'anonymous';

/** The actor for a request {@link gateOutcome} allowed. Same precedence as the gate. */
export function gateActor(i: GateInput): GateActor {
  if (i.mode === 'off') return 'open';
  if (i.mode === 'token') return i.hubTokenOk ? 'hub-token' : 'anonymous';
  if (i.surface === 'api' && i.bearerApiKeyOk) return 'api-key';
  if (i.surface === 'api' && i.deviceId) return `device:${i.deviceId}`;
  if (i.evidence.kind !== 'absent') return 'session';
  return 'anonymous';
}
