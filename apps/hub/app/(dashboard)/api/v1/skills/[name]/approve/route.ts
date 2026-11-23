// POST /api/v1/skills/{name}/approve [{version}] — apply the skill's pending
// version: it becomes current, and every running box behind on it syncs. With
// `version` (what the caller reviewed), a pending version that has moved since
// is refused with `conflict` instead of approving something unseen.
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';
import { failFromSkills, readJson } from '../../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const { name } = await ctx.params;
  const body = (await readJson(req)) ?? {};
  const version = typeof body.version === 'string' ? body.version : undefined;
  if (version !== undefined && !/^[0-9a-f]{7,64}$/.test(version)) {
    return fail('invalid_request', 'version must be 7 to 64 hex characters');
  }
  try {
    const { applied } = await backend.approveSkills([name], version ? { version } : {});
    return ok(applied[0]);
  } catch (err) {
    return failFromSkills(err, 'skill approve failed');
  }
}
