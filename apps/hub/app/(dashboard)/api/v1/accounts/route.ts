// GET /api/v1/accounts — the named LLM accounts of THIS hub's machine (its
//   `~/.agentbox/accounts.json`), plus the agents that can hold them:
//   `{ accounts: [{agent, id, label?, kind, identity?, hasSecret, boxes}],
//      agents: [{id, kinds}] }`. Never a secret.
// POST /api/v1/accounts — add a PASTEABLE account:
//   `{ agent, id, kind: 'api-key' | 'setup-token', token, label? }` → the account.
//   A `login` is interactive and runs on the machine: `agentbox <agent> login --account <id>`.
import { backendOrNull } from '../lib/backend';
import { fail, ok } from '../lib/envelope';
import { readJson } from '../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const backend = backendOrNull();
  // Host-machine state, like checkouts: the hosted/Postgres path holds none.
  if (!backend) return ok({ accounts: [], agents: [] });
  try {
    return ok(await backend.listAccounts());
  } catch (e) {
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}

export async function POST(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  const res = await backend.addPastedAccount(body.value);
  if (!res.ok) return fail(res.code, res.error);
  return ok({ account: res.value });
}
