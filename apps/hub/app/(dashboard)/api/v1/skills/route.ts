// GET /api/v1/skills — the hub's skills library: one row per stored skill
// (description, current version, size, file count, source PC, updated) plus
// `seeded`, which stays true after the last skill is discarded so the automatic
// first seed never refills a library the user emptied. Metadata only.
import { listSkills } from '@/lib/backend/skills';
import { ok } from '../lib/envelope';
import { failFromSkills, skillsStoreOrFail } from './_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const store = skillsStoreOrFail();
  if (store instanceof Response) return store;
  try {
    return ok(await listSkills(store));
  } catch (err) {
    return failFromSkills(err, 'skills list failed');
  }
}
