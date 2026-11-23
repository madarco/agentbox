// POST /api/v1/boxes/{id}/skills/sync — run `agentbox-ctl skills sync` in the box
// now, over the provider's exec (every provider). A box that isn't running is
// not woken: it answers `not-running` and pulls at its next start.
import { backendOrNull } from '../../../../lib/backend';
import { fail, ok } from '../../../../lib/envelope';
import { failFromSkills } from '../../../../skills/_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const { id } = await ctx.params;
  try {
    const [outcome] = await backend.syncSkillBoxes({ boxIds: [id] });
    return ok(outcome);
  } catch (err) {
    return failFromSkills(err, 'box skills sync failed');
  }
}
