// GET|DELETE /api/v1/checkpoints — the project checkpoint STORE (docker images +
// cloud snapshot manifests) on the hub's machine. Durable project assets, so they
// live and are managed where the boxes they warm are created.
//   GET    ?project=<abs root>            — one project's checkpoints
//   GET    ?global=1                       — every project's checkpoints
//   DELETE ?project=<abs root>&ref=<name>[&provider=<p>]
// Needs the in-process host backend; the Postgres/plane path 503s.
import { backendOrNull } from '../lib/backend';
import { fail, failFromAction, ok } from '../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const url = new URL(req.url);
  const global = url.searchParams.get('global') === '1';
  const project = url.searchParams.get('project') ?? undefined;
  if (!global && !project) {
    return fail(
      'invalid_request',
      'project is required (an absolute project root), or pass global=1',
    );
  }
  const listing = await backend.listCheckpoints({ project, global });
  return ok(listing);
}

export async function DELETE(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const url = new URL(req.url);
  const project = url.searchParams.get('project') ?? undefined;
  const ref = url.searchParams.get('ref') ?? undefined;
  const provider = url.searchParams.get('provider') ?? undefined;
  if (!project) return fail('invalid_request', 'project is required (an absolute project root)');
  if (!ref) return fail('invalid_request', 'ref is required (the checkpoint name)');
  const res = await backend.removeCheckpoint({ project, ref, provider });
  if (!res.ok) return failFromAction(res.error);
  return ok(res);
}
