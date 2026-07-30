// POST /api/v1/prune — fleet cleanup. Without a provider (or provider === 'docker')
// it removes orphan docker records/resources + orphan project configs; with a cloud
// provider it enumerates untracked sandboxes and (when !dryRun) deletes them AND
// reaps their control-box Store registrations (server-side, so the CLI no longer
// carries a separate reap). Needs the in-process host backend; Postgres/plane 503s.
import { backendOrNull } from '../lib/backend';
import { fail, ok } from '../lib/envelope';
import { parsePrune, readJson } from '../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const raw = await readJson(req);
  if (!raw.ok) return fail('invalid_request', raw.message);
  const parsed = parsePrune(raw.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message, parsed.details);

  const view = await backend.pruneFleet(parsed.value);
  if (view.kind === 'error') return fail('conflict', view.error);
  return ok(view);
}
