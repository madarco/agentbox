// GET /api/v1/checkouts — the checkouts registry: which machine has which repo
//   checked out where (`{ checkouts: CheckoutRecord[] }`, newest report first).
//   Filters: `?repoKey=<key>` and `?machineId=<id>`.
// PUT /api/v1/checkouts — one machine reports its own checkouts:
//   `{ machineId, label, entries: [{ repoKey, folder, head? }], removed?: [...] }`.
//   Idempotent; a report with no machine id is refused. The hub never infers a
//   checkout, since it cannot stat the reporting machine's disk.
import { backendOrNull } from '../lib/backend';
import { fail, ok } from '../lib/envelope';
import { parseCheckoutFilter, parseCheckoutReport, readJson } from '../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const backend = backendOrNull();
  // Host-machine state, like workspaces: the hosted/Postgres path holds none.
  if (!backend) return ok({ checkouts: [] });
  const filter = parseCheckoutFilter(new URL(req.url).searchParams);
  if (!filter.ok) return fail('invalid_request', filter.message);
  try {
    return ok({ checkouts: await backend.listCheckouts(filter.value) });
  } catch (e) {
    // An unreadable or corrupt registry file: say so, never answer "empty".
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}

export async function PUT(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const parsed = parseCheckoutReport(parsedBody.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);
  const res = await backend.reportCheckouts(parsed.value);
  if (!res.ok) return fail('internal', res.error);
  return ok({ checkouts: res.checkouts });
}
