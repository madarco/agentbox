// POST /api/v1/skill-machines/{id}/send {names, overwrite?} — "Send to <machine>":
// install each named library skill at ~/.agents/skills/<name> on that machine
// (plus a link for an agent that doesn't read it). A different local copy is
// replaced only with `overwrite`. A device confirms on its own side first.
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
    const results = await backend.sendSkills(id, names, {
      ...(body.overwrite === true ? { overwrite: true } : {}),
    });
    return ok({ results });
  } catch (err) {
    return failFromSkills(err, 'send failed');
  }
}
