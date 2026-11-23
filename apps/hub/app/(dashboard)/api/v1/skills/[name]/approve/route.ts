// POST /api/v1/skills/{name}/approve — apply the skill's pending version: it
// becomes current, and every running box behind on it syncs.
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';
import { failFromSkills } from '../../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const { name } = await ctx.params;
  try {
    const { applied } = await backend.approveSkills([name]);
    return ok(applied[0]);
  } catch (err) {
    return failFromSkills(err, 'skill approve failed');
  }
}
