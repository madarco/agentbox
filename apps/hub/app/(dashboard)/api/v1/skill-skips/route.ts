// GET /api/v1/skill-skips — the skills marked "never sync": `{skipped: [{name,
//     at}]}`. Keyed by name, so a name the library doesn't hold (a skill only on
//     a PC) can be listed. See ./[name]/route.ts to set or clear one.
import { listSkippedSkills } from '@/lib/backend/skill-skips';
import { ok } from '../lib/envelope';
import { failFromSkills, skillsStoreOrFail } from '../skills/_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const store = skillsStoreOrFail();
  if (store instanceof Response) return store;
  try {
    return ok({ skipped: await listSkippedSkills(store) });
  } catch (err) {
    return failFromSkills(err, 'skill skips read failed');
  }
}
