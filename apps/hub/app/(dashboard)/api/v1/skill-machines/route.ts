// GET /api/v1/skill-machines — the machines the skills page can compare the
// library with: the hub's own machine (unless it is a deployed server) and the
// enrolled devices, each with whether its relay is connected now.
import { backendOrNull } from '../lib/backend';
import { fail, ok } from '../lib/envelope';
import { failFromSkills } from '../skills/_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  try {
    return ok(await backend.skillMachines());
  } catch (err) {
    return failFromSkills(err, 'listing machines failed');
  }
}
