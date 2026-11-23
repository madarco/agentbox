// POST /api/v1/skills/{name}/refresh {allowFindings?} — re-fetch a git or
// marketplace skill. A changed tree lands as `pending` under the `manual` policy
// (the skill is behind until approved) or becomes current under `auto`.
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
  try {
    const [outcome] = await backend.refreshSkills([name], {
      ...(body.allowFindings === true ? { allowFindings: true } : {}),
    });
    return ok(outcome);
  } catch (err) {
    return failFromSkills(err, 'skill refresh failed');
  }
}
