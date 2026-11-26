import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { validShareId } from '@/lib/share/params';

const IMAGES = new Set(['opengraph-image', 'twitter-image']);

// Share pages are ISR-cached forever: refuse a malformed id or sub-path before Next
// renders (and caches) anything for it.
export function proxy(req: NextRequest): NextResponse {
  const [id, sub, ...rest] = req.nextUrl.pathname.split('/').slice(2);
  const bad =
    id === undefined ||
    (id !== 'example' && !validShareId(id)) ||
    (sub !== undefined && !IMAGES.has(sub)) ||
    rest.length > 0;
  if (bad) {
    return new NextResponse('Not found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' },
    });
  }
  return NextResponse.next();
}

export const config = { matcher: ['/s/:path+'] };
