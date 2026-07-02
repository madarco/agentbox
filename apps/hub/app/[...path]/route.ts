import { dispatch } from '../../lib/plane';

// The relay core needs node:crypto / pg — force the Node.js runtime, and never
// cache (every request is a live control-plane action).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// One catch-all maps every box/admin path (/healthz, /events, /rpc,
// /rpc/status/:id, /admin/*, /remote/*) onto the relay core. The path is read
// from the request URL, so the [...path] segment itself is unused.
export function GET(request: Request): Promise<Response> {
  return dispatch(request);
}

export function POST(request: Request): Promise<Response> {
  return dispatch(request);
}
