// GET /api/v1/skills/{name}/tarball[?version=<treeSha>] — stream a version's
// gzip tarball (default: current). `X-AgentBox-Skill-Version` names the tree
// hash; the CLI re-derives it from the extracted files before installing.
//
// Gated like custody's byte read (see `skillBytesReadAllowed`), not by the plain
// API key alone. A skipped skill (`/skill-skips`) answers 409: this is how a PC
// downloads one, and a skipped skill is never sent to a PC.
import { Readable } from 'node:stream';
import { assertNotSkipped } from '@/lib/backend/skill-skips';
import { openSkillTarball } from '@/lib/backend/skills';
import { fail } from '../../../lib/envelope';
import { failFromSkills, skillBytesReadAllowed, skillsStoreOrFail } from '../../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const store = skillsStoreOrFail();
  if (store instanceof Response) return store;
  if (!skillBytesReadAllowed(req)) {
    return fail(
      'unauthorized',
      'downloading a skill requires the admin token or an enrolled device token in X-Agentbox-Admin-Token (on a local hub: loopback); the hub API key can list skills but not read their bytes',
    );
  }
  const { name } = await ctx.params;
  const version = new URL(req.url).searchParams.get('version') ?? undefined;
  if (version !== undefined && !/^[0-9a-f]{64}$/.test(version)) {
    return fail('invalid_request', 'version must be a hex sha256 tree hash');
  }
  try {
    await assertNotSkipped(store, [name]);
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
