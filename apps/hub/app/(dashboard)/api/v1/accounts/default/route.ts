// GET /api/v1/accounts/default[?project=<abs folder>] — per agent, the account a
//   new box gets and where that comes from:
//   `{ defaults: { <agent>: { account, source: 'project'|'global'|'default', project?, global? } } }`.
//   Without `project` only the global setting counts.
// PUT /api/v1/accounts/default
//   `{ agent, account: string | null, scope?: 'global' | 'project', project? }` —
//   write `<agent>.account` in that config layer of THIS machine (`null` clears
//   it); the account must exist in the store. Answers the new `defaults`.
import { backendOrNull } from '../../lib/backend';
import { fail, ok } from '../../lib/envelope';
import { readJson } from '../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return ok({ defaults: {} });
  const project = new URL(req.url).searchParams.get('project') ?? undefined;
  try {
    const r = await backend.getAccountDefaults(project ? { project } : {});
    return r.ok ? ok({ defaults: r.value }) : fail(r.code, r.error);
  } catch (e) {
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}

export async function PUT(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  try {
    const r = await backend.setAccountDefault(body.value);
    return r.ok ? ok({ defaults: r.value }) : fail(r.code, r.error);
  } catch (e) {
    // An invalid config file names itself.
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}
