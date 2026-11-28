// GET /api/v1/settings/git-identity — `{ identity: { name, email } | null }`: the
//   committer identity this hub gives a box built with no PC behind it (a web-UI
//   or tray create). A CLI create sends the project's own identity, which wins.
// PUT /api/v1/settings/git-identity `{ identity: { name, email } | null, ifUnset? }`
//   — set it (`null` clears it) in this machine's global config
//   (`git.identity.name` / `git.identity.email`). With `ifUnset: true` an
//   identity already in force is kept and the answer carries `unchanged: true`:
//   how an enrolling PC offers its own without replacing anyone's choice.
import { backendOrNull } from '../../lib/backend';
import { fail, ok } from '../../lib/envelope';
import { readJson } from '../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  return ok(await backend.getHubGitIdentity());
}

export async function PUT(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  try {
    const r = await backend.setHubGitIdentity(body.value);
    return r.ok ? ok(r.value) : fail(r.code, r.error);
  } catch (e) {
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}
