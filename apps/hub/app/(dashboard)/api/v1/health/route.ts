// Public liveness probe for the API. Unauthenticated (proxy.ts allowlists it) and
// leaks no box state — just confirms the API is mounted and reports its version.
import { hubProfile } from '@/lib/auth-config';
import { ok } from '../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return ok({ ok: true, apiVersion: 'v1', profile: hubProfile() });
}
