// GET /api/v1/skill-machines/{id}/compare — the library next to that machine's
// skill dirs, one row per skill name: `same | differs | local-only | hub-only`,
// or `unknown` (with `error`) when the machine could not be asked. Metadata only.
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';
import { failFromSkills } from '../../../skills/_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const { id } = await ctx.params;
  try {
    return ok(await backend.compareMachineSkills(id));
  } catch (err) {
    return failFromSkills(err, 'skills comparison failed');
  }
}
