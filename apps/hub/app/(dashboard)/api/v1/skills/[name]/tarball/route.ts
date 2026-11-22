// GET /api/v1/skills/{name}/tarball[?version=<treeSha>] — stream a version's
// gzip tarball (default: current). `X-AgentBox-Skill-Version` names the tree
// hash; the CLI re-derives it from the extracted files before installing.
//
// Normal /api/v1 gate, unlike custody's elevated byte read: the skills scope
// holds instructions the user chose to share across their PCs, not credentials,
// and the PC-side secret scan keeps flagged files out unless the user overrode it.
import { Readable } from 'node:stream';
import { openSkillTarball } from '@/lib/backend/skills';
import { fail } from '../../../lib/envelope';
import { failFromSkills, skillsStoreOrFail } from '../../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const store = skillsStoreOrFail();
  if (store instanceof Response) return store;
  const { name } = await ctx.params;
  const version = new URL(req.url).searchParams.get('version') ?? undefined;
  if (version !== undefined && !/^[0-9a-f]{64}$/.test(version)) {
    return fail('invalid_request', 'version must be a hex sha256 tree hash');
  }
  try {
    const t = await openSkillTarball(store, name, version);
    return new Response(Readable.toWeb(Readable.from(t.data)) as ReadableStream, {
      headers: {
        'content-type': 'application/gzip',
        'content-length': String(t.bytes),
        'x-agentbox-skill-version': t.version,
        'x-agentbox-sha256': t.tarballSha256,
      },
    });
  } catch (err) {
    return failFromSkills(err, 'skill download failed');
  }
}
