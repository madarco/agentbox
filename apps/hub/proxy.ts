import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { authMode, cookieSecure, hubProfile, HUB_TOKEN_COOKIE } from '@/lib/auth-config';
import { readCookieEvidence } from '@/lib/session-cookie';
import {
  gateOutcome,
  sessionProbeOrigin,
  type GateInput,
  type GateOutcome,
  type ProbeResult,
} from '@/lib/session-gate';

/** Constant-time string compare (equal-length guard first). */
function tokenEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Public REST API surface. It shares the hub's gate but answers JSON 401s (never a
// /signin redirect, which a non-browser client can't follow) and accepts a Bearer
// token, since an IDE/API client can't carry the browser cookie.
const API_PREFIX = '/api/v1';
// The live-updates SSE stream is gated the same way as /api/v1: a headless client
// (the tray against a remote control box) reaches it with a Bearer key, not the
// browser session cookie. Kept out of API_PREFIX because it lives at /api/events.
const API_EVENTS = '/api/events';
// The job log stream, likewise polled by headless clients — it belongs to the API
// surface so a failure is a JSON 401 and not a redirect the client can't follow.
const API_JOBS = '/api/jobs/';
// Endpoints that never require auth: liveness + the spec + its docs page (no state).
const API_PUBLIC = new Set(['/api/v1/health', '/api/v1/openapi.json', '/api/v1/docs']);

// Marks the middleware's own session probe so it can never recurse, however the
// matcher below is edited later.
const PROBE_HEADER = 'x-agentbox-session-probe';
// The probe is loopback (or, on vercel, same-origin) — anything slower than this
// is a broken session store, and a broken session store must deny, not hang.
const PROBE_TIMEOUT_MS = 2_000;

function bearerOf(request: NextRequest): string {
  const h = request.headers.get('authorization');
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m ? m[1].trim() : '';
}

function apiUnauthorized(): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: 'unauthorized',
        message: 'Missing or invalid credentials. Send Authorization: Bearer <hub token>.',
      },
    },
    { status: 401 },
  );
}

function isApiSurface(pathname: string): boolean {
  return (
    pathname.startsWith(API_PREFIX) || pathname === API_EVENTS || pathname.startsWith(API_JOBS)
  );
}

/** Everything the gate can read synchronously off the request and the env. */
function readGateInput(request: NextRequest): GateInput {
  const mode = authMode();
  const pathname = request.nextUrl.pathname;
  const surface = isApiSurface(pathname) ? 'api' : 'page';

  const bearer = bearerOf(request);
  const expectedToken = process.env.AGENTBOX_HUB_TOKEN ?? '';
  const providedQueryToken = request.nextUrl.searchParams.get('token') ?? '';
  const cookieToken = request.cookies.get(HUB_TOKEN_COOKIE)?.value ?? '';
  const queryTokenOk = Boolean(expectedToken) && tokenEq(providedQueryToken, expectedToken);

  const apiKey = process.env.AGENTBOX_HUB_API_KEY ?? '';

  return {
    mode,
    surface,
    publicPath: API_PUBLIC.has(pathname),
    bearerApiKeyOk: Boolean(apiKey) && tokenEq(bearer, apiKey),
    hubTokenOk:
      Boolean(expectedToken) &&
      (tokenEq(bearer, expectedToken) || tokenEq(cookieToken, expectedToken) || queryTokenOk),
    hubTokenFromQuery: queryTokenOk,
    evidence: { kind: 'absent' },
    probe: 'skipped',
    now: Date.now(),
  };
}

/**
 * The authoritative session check: ask the hub's own better-auth endpoint, which
 * owns the one database handle. Doing it over HTTP rather than importing the auth
 * instance keeps `pg` / `node:sqlite` out of the middleware bundle entirely — `pg`
 * is in `serverExternalPackages`, which does not cover middleware, and a second
 * sqlite handle on `auth.db` would contend with the server's own (the node-sqlite
 * dialect sets no busy timeout, so contention throws rather than waits).
 *
 * better-auth re-mints the short-lived `session_data` cookie on this call, so the
 * caller forwards its `set-cookie` and the next few minutes are answered by the
 * crypto path with no probe at all.
 *
 * Fails closed: a non-2xx, a throw or a timeout is `error`, which denies. That is
 * also what covers the window between the socket opening and the auth tables
 * existing on a cold start.
 */
async function probeSession(
  request: NextRequest,
): Promise<{ result: ProbeResult; setCookie: string[] }> {
  if (request.headers.get(PROBE_HEADER)) return { result: 'error', setCookie: [] };
  const cookie = request.headers.get('cookie');
  if (!cookie) return { result: 'invalid', setCookie: [] };
  const origin = sessionProbeOrigin({
    profile: hubProfile(),
    requestOrigin: request.nextUrl.origin,
    hubPort: process.env.AGENTBOX_HUB_PORT,
  });
  try {
    const res = await fetch(new URL('/api/auth/get-session', origin), {
      headers: { cookie, [PROBE_HEADER]: '1', accept: 'application/json' },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { result: 'error', setCookie: [] };
    // No session is `200` with a literal `null` body, not an error status.
    const body = (await res.json()) as { session?: unknown } | null;
    return {
      result: body?.session ? 'valid' : 'invalid',
      setCookie: res.headers.getSetCookie(),
    };
  } catch {
    return { result: 'error', setCookie: [] };
  }
}

function render(request: NextRequest, outcome: GateOutcome, refreshed: string[]): NextResponse {
  switch (outcome.kind) {
    case 'allow': {
      const res = NextResponse.next();
      // Carry the probe's refreshed session-data cookie back to the browser, so a
      // steady session costs one probe per cookie-cache window, not one per request.
      for (const c of refreshed) res.headers.append('set-cookie', c);
      return res;
    }
    case 'api-401':
      return apiUnauthorized();
    case 'signin-redirect':
      return NextResponse.redirect(
        new URL('/signin?returnUrl=' + request.nextUrl.pathname, request.url),
      );
    case 'token-locked':
      return new NextResponse('AgentBox hub is locked. Open it with `agentbox hub`.', {
        status: 401,
        headers: { 'content-type': 'text/plain' },
      });
    case 'token-handshake': {
      // `?token=` matched: set the cookie once and redirect to the clean URL;
      // thereafter the cookie authorizes.
      const clean = request.nextUrl.clone();
      clean.searchParams.delete('token');
      const res = NextResponse.redirect(clean);
      res.cookies.set(HUB_TOKEN_COOKIE, process.env.AGENTBOX_HUB_TOKEN ?? '', {
        httpOnly: true,
        sameSite: 'lax',
        secure: false, // localhost is http
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      });
      return res;
    }
    case 'misconfigured': {
      const message =
        'AgentBox hub is misconfigured: BETTER_AUTH_SECRET is not set, so it cannot authenticate anyone. ' +
        'Redeploy with `agentbox hub update`, or set AGENTBOX_HUB_AUTH=off to serve deliberately without auth.';
      return isApiSurface(request.nextUrl.pathname)
        ? NextResponse.json({ error: { code: 'hub_misconfigured', message } }, { status: 503 })
        : new NextResponse(message, { status: 503, headers: { 'content-type': 'text/plain' } });
    }
    case 'probe':
      // Unreachable: the caller resolves `probe` before rendering. Fail closed.
      return apiUnauthorized();
  }
}

// Next 16 middleware. Gates the hub UI by mode. The matcher excludes every
// relay-owned prefix so that on vercel (where those paths are the app/[...path]
// catch-all) box→host comms and the bearer-gated /admin/* are never redirected to
// /signin. On the embedded server the relay already handles those before Next, so
// the exclusions are belt-and-suspenders there.
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const input = readGateInput(request);

  // Crypto only — no I/O. Skipped entirely unless a cookie could decide the
  // request, so the headless Bearer path and the token profile pay nothing.
  if (
    input.mode === 'password' &&
    !input.publicPath &&
    !(input.surface === 'api' && input.bearerApiKeyOk)
  ) {
    input.evidence = await readCookieEvidence(request.headers, {
      secret: process.env.BETTER_AUTH_SECRET,
      secureCookies: cookieSecure(),
    });
  }

  let outcome = gateOutcome(input);
  let refreshed: string[] = [];
  if (outcome.kind === 'probe') {
    const probe = await probeSession(request);
    refreshed = probe.setCookie;
    outcome = gateOutcome({ ...input, probe: probe.result });
  }
  return render(request, outcome, refreshed);
}

// Proxy always runs on the Node.js runtime in Next 16, so `getSessionCookie`
// and the auth-config env read work here directly.
export const config = {
  // `logo.svg` (the mark on the sign-in page + the favicon) must be excluded, or
  // a password-profile hub redirects the unauthenticated asset request to
  // /signin and the sign-in page renders a broken image. Same reasoning as
  // favicon.ico — public static assets are not gated.
  //
  // `api/auth` staying excluded is now load-bearing for correctness, not just for
  // the sign-in page: `probeSession` calls `/api/auth/get-session`, and gating
  // that path would make the probe recurse into itself. The PROBE_HEADER guard
  // catches it, but only by denying.
  matcher: [
    '/((?!api/auth|signin|healthz|admin|rpc|events|bridge|remote|_next/static|_next/image|favicon.ico|logo.svg).*)',
  ],
};
