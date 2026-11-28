// POST /api/v1/accounts/import — a PC's logins and keys into THIS hub's account
//   store (docs/llm-accounts-plan.md, Phase 9: on a remote hub a subscription
//   belongs to the hub). Body `{ items: [{agent, id, kind, identity?, secret,
//   machine, machineLabel?, force?}] }` → `{ results: [{agent, id, hubId?,
//   action, reason}] }`, one per item. The hub decides: dedupe by identity,
//   a suffixed id on a collision, newest-wins on the secret. Never returns one.
//   A device token may only send its own `machine` (403 otherwise).
import { backendOrNull } from '../../lib/backend';
import { fail, ok } from '../../lib/envelope';
import { readJson } from '../../lib/validate';
import { DEVICE_ID_HEADER } from '@/lib/peer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  // A PC on its own device token imports its own accounts only: `machine` keys
  // the mappings a create resolves a PC's names through, the tombstones and
  // the pasted-token setter, so one device must not act as another. The header
  // is set by server.ts from the verified token (a client copy is stripped).
  // The owner's API key keeps acting for any machine.
  const device = (req.headers.get(DEVICE_ID_HEADER) ?? '').trim();
  if (device) {
    const items = (body.value as { items?: unknown } | null)?.items;
    const other = Array.isArray(items)
      ? items.find((i) => (i as { machine?: unknown } | null)?.machine !== device)
      : undefined;
    if (other !== undefined) {
      return fail('forbidden', 'a device can only import its own accounts');
    }
  }
  try {
    const res = await backend.importAccounts(body.value);
    if (!res.ok) return fail(res.code, res.error);
    return ok({ results: res.value });
  } catch (e) {
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}
