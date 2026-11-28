// POST /api/v1/accounts/import — a PC's logins and keys into THIS hub's account
//   store (docs/llm-accounts-plan.md, Phase 9: on a remote hub a subscription
//   belongs to the hub). Body `{ items: [{agent, id, kind, identity?, secret,
//   machine, machineLabel?, force?}] }` → `{ results: [{agent, id, hubId?,
//   action, reason}] }`, one per item. The hub decides: dedupe by identity,
//   a suffixed id on a collision, newest-wins on the secret. Never returns one.
import { backendOrNull } from '../../lib/backend';
import { fail, ok } from '../../lib/envelope';
import { readJson } from '../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  try {
    const res = await backend.importAccounts(body.value);
    if (!res.ok) return fail(res.code, res.error);
    return ok({ results: res.value });
  } catch (e) {
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}
