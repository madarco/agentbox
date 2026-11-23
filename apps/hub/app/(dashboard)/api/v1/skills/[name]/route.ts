// PUT    /api/v1/skills/{name} — store a version: raw gzip tarball body, metadata
//        in the `X-AgentBox-Skill-Meta` header (base64 JSON: sha256 tree hash,
//        description, size, files, source). Streamed straight into custody,
//        capped by AGENTBOX_CUSTODY_MAX_BLOB_BYTES.
// DELETE /api/v1/skills/{name} — discard the skill and every stored version,
//        and forget its skill bindings.
import { Readable } from 'node:stream';
import { discardSkill, importSkill, parseImportMeta } from '@/lib/backend/skills';
import { dropSkillBindings } from '@/lib/backend/skill-bindings';
import { fail, ok } from '../../lib/envelope';
import { failFromSkills, skillsStoreOrFail } from '../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SKILL_META_HEADER = 'x-agentbox-skill-meta';

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const store = skillsStoreOrFail();
  if (store instanceof Response) return store;
  const { name } = await ctx.params;
  const rawMeta = req.headers.get(SKILL_META_HEADER);
  if (!rawMeta) return fail('invalid_request', `missing ${SKILL_META_HEADER} header`);
  if (!req.body) return fail('invalid_request', 'expected a tarball request body');
  try {
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(rawMeta, 'base64').toString('utf8'));
    } catch {
      return fail('invalid_request', `${SKILL_META_HEADER} must be base64-encoded JSON`);
    }
    const meta = parseImportMeta(decoded);
    // DOM ReadableStream → node stream; the same bridge the custody blob route uses.
    const webBody = req.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>;
    const result = await importSkill(store, {
      name,
      meta,
      body: Readable.fromWeb(webBody),
      ...(globalThis.__AGENTBOX_HUB_CUSTODY_MAX_BLOB_BYTES !== undefined
        ? { maxBytes: globalThis.__AGENTBOX_HUB_CUSTODY_MAX_BLOB_BYTES }
        : {}),
    });
    return ok(result);
  } catch (err) {
    return failFromSkills(err, 'skill import failed');
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const store = skillsStoreOrFail();
  if (store instanceof Response) return store;
  const { name } = await ctx.params;
  try {
    const out = await discardSkill(store, name);
    // A binding naming a skill the library no longer holds selects nothing, so
    // a failure here is not worth failing the discard over.
    await dropSkillBindings(store, name).catch(() => undefined);
    return ok({ name, ...out });
  } catch (err) {
    return failFromSkills(err, 'skill discard failed');
  }
}
