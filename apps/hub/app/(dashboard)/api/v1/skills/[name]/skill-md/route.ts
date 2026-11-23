// GET /api/v1/skills/{name}/skill-md[?version=] — a version's SKILL.md (default:
//     current) plus the version's file list. ELEVATED like /diff: it returns content.
// PUT /api/v1/skills/{name}/skill-md {content, base?, allowFindings?} — the web
//     editor's save. The hub copies the base version's other files, swaps
//     SKILL.md, checks the frontmatter (name must match, description required)
//     and the secret scan, and stores the tree as a new `upload` version that
//     becomes current; running boxes that hold the skill sync. `base` is the
//     version the editor opened: a save over a skill that moved since is refused.
//     Without `base`, the skill must not exist yet (a new skill, SKILL.md only).
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';
import { failFromSkills, readJson, skillBytesReadAllowed } from '../../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VERSION_RE = /^[0-9a-f]{7,64}$/;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  if (!skillBytesReadAllowed(req)) {
    return fail(
      'unauthorized',
      'reading skill content needs the admin token or an enrolled device token (X-Agentbox-Admin-Token)',
    );
  }
  const { name } = await ctx.params;
  const version = new URL(req.url).searchParams.get('version') ?? undefined;
  if (version !== undefined && !VERSION_RE.test(version)) {
    return fail('invalid_request', 'version must be 7 to 64 hex characters');
  }
  try {
    return ok(await backend.readSkillMd(name, version));
  } catch (err) {
    return failFromSkills(err, 'skill read failed');
  }
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const { name } = await ctx.params;
  const body = await readJson(req);
  if (!body || typeof body.content !== 'string') {
    return fail('invalid_request', 'body must be {"content": "<SKILL.md>", "base"?: "<version>"}');
  }
  if (
    body.base !== undefined &&
    (typeof body.base !== 'string' || !/^[0-9a-f]{64}$/.test(body.base))
  ) {
    return fail('invalid_request', 'base must be the full version id the editor opened');
  }
  try {
    return ok(
      await backend.saveSkillMd(name, {
        content: body.content,
        ...(typeof body.base === 'string' ? { base: body.base } : {}),
        ...(body.allowFindings === true ? { allowFindings: true } : {}),
      }),
    );
  } catch (err) {
    return failFromSkills(err, 'skill save failed');
  }
}
