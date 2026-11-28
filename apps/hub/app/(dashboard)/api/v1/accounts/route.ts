// GET /api/v1/accounts[?project=<abs folder>] — the LLM accounts of THIS hub's
//   machine (its `~/.agentbox/accounts.json`), plus the agents that can hold them:
//   `{ accounts: [{agent, id, kind, identity?, hasSecret, boxes, limits?,
//      auth: {state, since?, box?, detail?}, default?: {global?, project?}}],
//      agents: [{id, kinds}], defaults: {<agent>: {account, source, ...}},
//      storeError? }` — `storeError` names an untrustworthy accounts.json.
//   `project` adds that project's setting to `defaults` and `default`. Never a secret.
// POST /api/v1/accounts — add a PASTEABLE account:
//   `{ agent, id, kind: 'api-key' | 'setup-token', token, replace? }` → the account.
//   A `login` is interactive and runs on the machine: `agentbox credentials add <agent>/<id> --login`.
import { backendOrNull } from '../lib/backend';
import { fail, ok } from '../lib/envelope';
import { readJson } from '../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const backend = backendOrNull();
  // Host-machine state, like checkouts: the hosted/Postgres path holds none.
  if (!backend) return ok({ accounts: [], agents: [], defaults: {} });
  const project = new URL(req.url).searchParams.get('project') ?? undefined;
  try {
    return ok(await backend.listAccounts(project ? { project } : {}));
  } catch (e) {
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}

export async function POST(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  try {
    const res = await backend.addPastedAccount(body.value);
    if (!res.ok) return fail(res.code, res.error);
    return ok({ account: res.value });
  } catch (e) {
    // An unreadable store (a corrupt accounts.json names itself) or a failed
    // write: an error envelope, never a bare 500.
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}
