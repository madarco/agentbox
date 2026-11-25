// GET /api/v1/accounts/policy — `{ onLimit: 'ask' | 'switch' }`: what this hub
//   does when a running box's account is at its plan limit (hub settings 3c).
// PUT /api/v1/accounts/policy `{ onLimit }` — set it (this machine's global
//   config key `accounts.onLimit`).
import { backendOrNull } from '../../lib/backend';
import { fail, ok } from '../../lib/envelope';
import { readJson } from '../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  return ok(await backend.getAccountPolicy());
}

export async function PUT(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  try {
    const r = await backend.setAccountPolicy(body.value);
    return r.ok ? ok(r.value) : fail(r.code, r.error);
  } catch (e) {
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}
