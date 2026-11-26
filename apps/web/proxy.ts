import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { HANDLE_RE } from '@agentbox/usage-view';

// Share pages are ISR-cached forever: refuse a malformed handle or share number
// before Next renders (and caches) anything for it.
export function proxy(req: NextRequest): NextResponse {
  const [handle, n] = req.nextUrl.pathname.split('/').slice(2);
  const exampleImage = handle === 'example' && (n === 'opengraph-image' || n === 'twitter-image');
  const bad =
    (handle !== undefined && !HANDLE_RE.test(handle)) ||
    (n !== undefined && !exampleImage && !/^[1-9]\d{0,8}$/.test(n));
  if (bad) {
    return new NextResponse('Not found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' },
    });
  }
  return NextResponse.next();
}

export const config = { matcher: ['/u/:path+'] };
