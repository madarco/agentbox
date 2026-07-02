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

// Next 16 middleware. Gates the hub UI by mode. The matcher excludes every
// relay-owned prefix so that on vercel (where those paths are the app/[...path]
// catch-all) box→host comms and the bearer-gated /admin/* are never redirected to
// /signin. On the embedded server the relay already handles those before Next, so
// the exclusions are belt-and-suspenders there.
export function proxy(request: NextRequest): NextResponse {
  const mode = authMode();
  if (mode === 'off') return NextResponse.next();

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
