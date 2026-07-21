// GET /api/v1/providers — sandbox providers and whether each is configured (its
// base baked) on this host. Read-only; drives create-target discovery for clients
// (POST /boxes accepts a `provider`). Topology-agnostic via readState().
//
// `?freshness=1` additionally reports base-image staleness (`baseStatus`/
// `baseStaleReason`) so the settings UI + tray can nag "needs re-bake". That
// computation loads provider code and hashes the runtime build context, so it's
// kept OFF the default path (and off getData()) — only this opt-in flag pays it,
// and only when the in-process host backend is available (the Postgres/plane
// read path has no provider code, so it silently omits freshness).
import { backendOrNull, readState } from '../lib/backend';
import { ok } from '../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const wantsFreshness = params.get('freshness') === '1';
  // `?hosts=expand` (create pickers only) lists each registered remote-docker host
  // as its own `docker:<alias>` provider option. Settings never passes it.
  const wantsHosts = params.get('hosts') === 'expand';
  const backend = backendOrNull();
  if ((wantsFreshness || wantsHosts) && backend) {
    return ok({
      providers: await backend.providersWithFreshness({ expandRemoteDockerHosts: wantsHosts }),
    });
  }
  const { providers } = await readState();
  return ok({ providers });
}
