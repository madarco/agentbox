import { toNextJsHandler } from 'better-auth/next-js';
import { authMode } from '@/lib/auth-config';
import { getAuth } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// getAuth() is async (the DB driver is created lazily), so wrap the better-auth
// handler per request. Only the password profiles construct better-auth; on
// localhost (token/off) this route 404s.
async function handle(req: Request): Promise<Response> {
  if (authMode() !== 'password') return new Response('auth disabled', { status: 404 });
  const auth = await getAuth();
  const { GET, POST } = toNextJsHandler(auth);
  return req.method === 'POST' ? POST(req) : GET(req);
}

export const GET = handle;
export const POST = handle;
