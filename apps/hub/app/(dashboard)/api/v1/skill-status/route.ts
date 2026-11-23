// GET /api/v1/skill-status — what a badge needs in one call: the skills with an
// update waiting for approval (`pending`), and the live boxes holding something
// other than the library's current version (`boxes[].behind`, skill names).
// Metadata only. Approve with POST /skills/{name}/approve; bring a box level with
// POST /boxes/{id}/skills/sync.
import { backendOrNull } from '../lib/backend';
import { fail, ok } from '../lib/envelope';
import { failFromSkills } from '../skills/_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  try {
    return ok(await backend.skillsStatus());
  } catch (err) {
    return failFromSkills(err, 'skill status failed');
  }
}
