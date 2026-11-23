// GET /api/v1/skills/{name}/diff?from=<sha>&to=<sha> — file-level changes
// between two stored versions, with text bodies (binary and large files are
// named only). Defaults: to = the pending version (else current), from =
// current (else the version before it). A unique prefix (7+ hex) works.
// ELEVATED like the tarball route: it returns file content.
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';
import { failFromSkills, skillBytesReadAllowed } from '../../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VERSION_RE = /^[0-9a-f]{7,64}$/;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  // The diff carries file CONTENT, so it takes the same elevated read as the tarball.
  if (!skillBytesReadAllowed(req)) {
    return fail(
      'unauthorized',
      'reading skill content needs the admin token or an enrolled device token (X-Agentbox-Admin-Token)',
    );
  }
  const { name } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const from = q.get('from') ?? undefined;
  const to = q.get('to') ?? undefined;
  for (const v of [from, to]) {
    if (v !== undefined && !VERSION_RE.test(v)) {
      return fail('invalid_request', 'from/to must be a version (7 to 64 hex characters)');
    }
  }
  try {
    return ok(await backend.skillDiff(name, { ...(from ? { from } : {}), ...(to ? { to } : {}) }));
  } catch (err) {
    return failFromSkills(err, 'skill diff failed');
  }
}
