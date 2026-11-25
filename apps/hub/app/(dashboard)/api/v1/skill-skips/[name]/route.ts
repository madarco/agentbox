// PUT    /api/v1/skill-skips/{name} — skip a skill: never synced again. It is not
//        delivered to boxes (a running box that holds it drops it at its next
//        skills sync, started now), not imported from a PC (first seed, upload,
//        pull) and not sent to one; the comparison shows it as `skipped`.
// DELETE /api/v1/skill-skips/{name} — sync it again; boxes that pulled from this
//        hub sync now, so a running box gets it back.
// Neither deletes the skill from the library or a PC. Both answer the list
// after the write: `{changed, skipped: [{name, at}]}`.
import { setSkillSkipped } from '@/lib/backend/skill-skips';
import { backendOrNull } from '../../lib/backend';
import { ok } from '../../lib/envelope';
import { failFromSkills, skillsStoreOrFail } from '../../skills/_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function set(ctx: { params: Promise<{ name: string }> }, skip: boolean): Promise<Response> {
  const store = skillsStoreOrFail();
  if (store instanceof Response) return store;
  const { name } = await ctx.params;
  try {
    const res = await setSkillSkipped(store, name, skip);
    // A box holding a newly skipped skill counts as behind: sync it so it drops it.
    if (res.changed) {
      if (skip) backendOrNull()?.skillsChanged([name]);
      else backendOrNull()?.skillUnskipped(name);
    }
    return ok(res);
  } catch (err) {
    return failFromSkills(err, 'skill skip write failed');
  }
}

export function PUT(_req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
  return set(ctx, true);
}

export function DELETE(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  return set(ctx, false);
}
