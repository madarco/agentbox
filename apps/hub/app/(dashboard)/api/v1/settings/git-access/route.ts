// GET /api/v1/settings/git-access — how this hub reaches GitHub: `local` (the
//   PC's own git and `gh`), `gh` (a token copied to the control box at setup) or
//   `app` (a GitHub App leasing 1-hour single-repo tokens). Read-only; the token
//   itself is never returned.
import { backendOrNull } from '../../lib/backend';
import { fail, ok } from '../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  try {
    return ok(await backend.getGitAccess());
  } catch (e) {
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}
