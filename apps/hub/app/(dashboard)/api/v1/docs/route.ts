// GET /api/v1/docs — a Scalar-rendered reference for the spec (public convenience
// page; proxy.ts allowlists it). The API is fully usable without it.
import { docsHtml } from '../lib/openapi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response(docsHtml(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
