// GET /api/v1/skills/{name}/diff?from=<sha>&to=<sha> — file-level changes
// between two stored versions, with text bodies (binary and large files are
// named only). Defaults: to = the pending version (else current), from =
// current (else the version before it).
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';
import { failFromSkills } from '../../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SHA_RE = /^[0-9a-f]{64}$/;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const { name } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const from = q.get('from') ?? undefined;
  const to = q.get('to') ?? undefined;
  for (const v of [from, to]) {
    if (v !== undefined && !SHA_RE.test(v))
      return fail('invalid_request', 'from/to must be a 64-hex version');
  }
  try {
    return ok(await backend.skillDiff(name, { ...(from ? { from } : {}), ...(to ? { to } : {}) }));
  } catch (err) {
    return failFromSkills(err, 'skill diff failed');
  }
}
