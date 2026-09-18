// GET  /api/v1/workspaces — registered workspaces (projects + per-host folders).
// POST /api/v1/workspaces — register `{ host, root, projects }`, the scan the
//   CLIENT ran on its own machine. Idempotent: matched by id, then by
//   (host, root), then by a shared repo — a second machine's checkout of the
//   same repos merges its folder mapping into the existing record.
import { backendOrNull } from '../lib/backend';
import { fail, failFromAction, ok } from '../lib/envelope';
import { parseWorkspaceAdd, readJson } from '../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const backend = backendOrNull();
  // Workspaces are host-machine state; the hosted/Postgres path holds none, and
  // an empty list is the honest answer there rather than a 503.
  if (!backend) return ok({ workspaces: [] });
  return ok({ workspaces: await backend.listWorkspaces() });
}

export async function POST(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const parsed = parseWorkspaceAdd(parsedBody.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const res = await backend.addWorkspace(parsed.value);
  if (!res.ok) return failFromAction(res.error);
  return ok(res.workspace);
}
