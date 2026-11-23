// GET /api/v1/boxes/{id}/skills — the library skills this box was last served,
// each with the library's current version, a pending one, and `behind` (the box
// holds something other than current: it slept through an update or its sync
// failed). Empty `skills` and no `recordedAt` = the box never pulled from this hub.
import { boxSkillsStatus } from '@/lib/backend/skill-boxes';
import { ok } from '../../../lib/envelope';
import { failFromSkills, skillsStoreOrFail } from '../../../skills/_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const store = skillsStoreOrFail();
  if (store instanceof Response) return store;
  const { id } = await ctx.params;
  try {
    return ok(await boxSkillsStatus(store, id));
  } catch (err) {
    return failFromSkills(err, 'box skills read failed');
  }
}
