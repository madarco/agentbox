import { timingSafeEqual } from 'node:crypto';
import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';
import { authMode, HUB_TOKEN_COOKIE } from '@/lib/auth-config';

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
// Endpoints that never require auth: liveness + the spec + its docs page (no state).
const API_PUBLIC = new Set(['/api/v1/health', '/api/v1/openapi.json', '/api/v1/docs']);

function bearerOf(request: NextRequest): string | null {
  const h = request.headers.get('authorization');
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m ? m[1].trim() : null;
}

function apiUnauthorized(): NextResponse {
  return NextResponse.json(
    { error: { code: 'unauthorized', message: 'Missing or invalid credentials. Send Authorization: Bearer <hub token>.' } },
    { status: 401 },
  );
}

// Gate a /api/v1 request. `mode` is never 'off' here (handled by the caller).
function gateApi(request: NextRequest, mode: 'token' | 'password'): NextResponse {
  if (API_PUBLIC.has(request.nextUrl.pathname)) return NextResponse.next();
  if (mode === 'token') {
    const expected = process.env.AGENTBOX_HUB_TOKEN ?? '';
    if (!expected) return apiUnauthorized();
    const bearer = bearerOf(request);
    if (bearer && tokenEq(bearer, expected)) return NextResponse.next();
    // Same-origin browser fetches (the hub's own UI) carry the token cookie.
    const cookie = request.cookies.get(HUB_TOKEN_COOKIE)?.value;
    if (cookie && tokenEq(cookie, expected)) return NextResponse.next();
    return apiUnauthorized();
  }
  // password (hetzner/vercel): a headless Bearer API key (CLI / tray / IDE against
  // a remote control box, which can't carry the browser session cookie), else the
  // better-auth session cookie for the hub's own UI. The key gates only /api/v1 —
  // the page gate below still requires a real login, so a leaked key can't reach
  // the UI. Unset key → the cookie-only path (unchanged from before this existed).
  const apiKey = process.env.AGENTBOX_HUB_API_KEY ?? '';
  if (apiKey) {
    const bearer = bearerOf(request);
    if (bearer && tokenEq(bearer, apiKey)) return NextResponse.next();
  }
  if (getSessionCookie(request)) return NextResponse.next();
  return apiUnauthorized();
}

// Next 16 middleware. Gates the hub UI by mode. The matcher excludes every
// relay-owned prefix so that on vercel (where those paths are the app/[...path]
// catch-all) box→host comms and the bearer-gated /admin/* are never redirected to
// /signin. On the embedded server the relay already handles those before Next, so
// the exclusions are belt-and-suspenders there.
export function proxy(request: NextRequest): NextResponse {
  const mode = authMode();
  if (mode === 'off') return NextResponse.next();

  // The public API is gated but answers JSON (not a signin redirect) and accepts
  // a Bearer token — handle it before the browser flows below.
  if (request.nextUrl.pathname.startsWith(API_PREFIX)) return gateApi(request, mode);

  // localhost token gate: a shared-secret cookie, no login screen. `?token=`
  // sets the cookie once and redirects to the clean URL; thereafter the cookie
  // authorizes. Direct access with neither is locked.
  if (mode === 'token') {
    const expected = process.env.AGENTBOX_HUB_TOKEN ?? '';
    const provided = request.nextUrl.searchParams.get('token');
    if (provided && expected && tokenEq(provided, expected)) {
      const clean = request.nextUrl.clone();
      clean.searchParams.delete('token');
      const res = NextResponse.redirect(clean);
      res.cookies.set(HUB_TOKEN_COOKIE, expected, {
        httpOnly: true,
        sameSite: 'lax',
        secure: false, // localhost is http
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      });
      return res;
    }
    const cookie = request.cookies.get(HUB_TOKEN_COOKIE)?.value;
    if (cookie && expected && tokenEq(cookie, expected)) return NextResponse.next();
    return new NextResponse('AgentBox hub is locked. Open it with `agentbox hub`.', {
      status: 401,
      headers: { 'content-type': 'text/plain' },
    });
  }

  // password (hetzner/vercel): lightweight cookie presence check — no DB hit.
  // Session validity is enforced by the handlers / server components that read it.
  if (getSessionCookie(request)) return NextResponse.next();
  return NextResponse.redirect(new URL('/signin?returnUrl=' + request.nextUrl.pathname, request.url));
}

// Proxy always runs on the Node.js runtime in Next 16, so `getSessionCookie`
// and the auth-config env read work here directly.
export const config = {
  matcher: [
    '/((?!api/auth|signin|healthz|admin|rpc|events|bridge|remote|_next/static|_next/image|favicon.ico).*)',
  ],
};
