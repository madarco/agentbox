// GET /api/v1/providers — sandbox providers and whether each is configured (its
// base baked) on this host. Read-only; drives create-target discovery for clients
// (POST /boxes accepts a `provider`). Topology-agnostic via readState().
import { readState } from '../lib/backend';
import { ok } from '../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { providers } = await readState();
  return ok({ providers });
}
