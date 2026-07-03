// GET /api/v1/openapi.json — the OpenAPI 3.1 spec (public; proxy.ts allowlists it).
import { buildOpenApi } from '../lib/openapi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json(buildOpenApi());
}
