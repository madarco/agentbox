// GET  /api/v1/projects — registered projects (create targets).
// POST /api/v1/projects — register a folder (`{ path }`, absolute) as a project,
//   or create a new one (`{ parent, name, git? }` makes `<parent>/<name>` first).
//   Both answer `{ ok, id, path }`.
import { backendOrNull, readState } from '../lib/backend';
import { fail, ok } from '../lib/envelope';
import { parseProject, readJson } from '../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { projects } = await readState();
  return ok({ projects });
}

export async function POST(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const parsed = parseProject(parsedBody.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const body = parsed.value;
  const res =
    body.kind === 'register'
      ? await backend.addProject(body.path)
      : await backend.createProject({ parent: body.parent, name: body.name, git: body.git });
  if (!res.ok) return fail('invalid_request', res.error);
  return ok({ ok: true, id: res.id, path: res.path });
}
