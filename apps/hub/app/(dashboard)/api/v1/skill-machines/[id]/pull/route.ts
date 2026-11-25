// POST /api/v1/skill-machines/{id}/pull {names, allowFindings?} — "Pull to Hub":
// read each named skill off that machine and import it into the library. A
// device confirms on its own side first. Takes the elevated skill-content auth:
// it moves a PC's files into the library every box reads.
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';
import { failFromSkills, readJson, skillBytesReadAllowed } from '../../../skills/_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  if (!skillBytesReadAllowed(req)) {
    return fail(
      'forbidden',
      'moving skills to and from a machine needs the owner session or the admin token',
    );
  }
  const { id } = await ctx.params;
  const body = (await readJson(req)) ?? {};
  const names = Array.isArray(body.names)
    ? body.names.filter((n): n is string => typeof n === 'string')
    : [];
  if (names.length === 0) return fail('invalid_request', 'body needs {names: string[]}');
  try {
    const results = await backend.pullSkills(id, names, {
      ...(body.allowFindings === true ? { allowFindings: true } : {}),
    });
    return ok({ results });
  } catch (err) {
    return failFromSkills(err, 'pull failed');
  }
}
