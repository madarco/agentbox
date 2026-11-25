// PUT    /api/v1/skills/{name} — store a version: raw gzip tarball body, metadata
//        in the `X-AgentBox-Skill-Meta` header (base64 JSON: sha256 tree hash,
//        description, size, files, source). Streamed straight into custody,
//        capped by AGENTBOX_CUSTODY_MAX_BLOB_BYTES.
//        Under the skill's `auto` policy the version becomes current and every
//        running box behind on it syncs; under `manual` it waits as pending.
// PATCH  /api/v1/skills/{name} {policy: 'auto'|'manual'} — the update policy.
// DELETE /api/v1/skills/{name} — discard the skill and every stored version.
//        Its skill bindings stay, so a global `disable` still holds if a skill
//        of the same name is imported again.
import { Readable } from 'node:stream';
import {
  discardSkill,
  importSkill,
  parseImportMeta,
  parsePolicy,
  setSkillPolicy,
} from '@/lib/backend/skills';
import { backendOrNull } from '../../lib/backend';
import { fail, ok } from '../../lib/envelope';
import { failFromSkills, readJson, skillsStoreOrFail } from '../_service';

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
    // The declared length: a body that arrives shorter (or longer) is refused
    // rather than stored as a version, whatever cut it on the way.
    const cl = req.headers.get('content-length')?.trim();
    const declared = cl ? Number(cl) : NaN;
    const result = await importSkill(store, {
      name,
      meta,
      body: Readable.fromWeb(webBody),
      ...(Number.isSafeInteger(declared) && declared >= 0 ? { expectedBytes: declared } : {}),
      ...(globalThis.__AGENTBOX_HUB_CUSTODY_MAX_BLOB_BYTES !== undefined
        ? { maxBytes: globalThis.__AGENTBOX_HUB_CUSTODY_MAX_BLOB_BYTES }
        : {}),
    });
    if (result.currentChanged) backendOrNull()?.skillsChanged([name]);
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
    const res = await discardSkill(store, name);
    // Boxes holding it are now behind (the skill is gone): sync removes it.
    backendOrNull()?.skillsChanged([name]);
    return ok({ name, ...res });
  } catch (err) {
    return failFromSkills(err, 'skill discard failed');
  }
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const store = skillsStoreOrFail();
  if (store instanceof Response) return store;
  const { name } = await ctx.params;
  const body = await readJson(req);
  if (!body || body.policy === undefined)
    return fail('invalid_request', 'body must be {"policy": "auto"|"manual"}');
  try {
    return ok(await setSkillPolicy(store, name, parsePolicy(body.policy)));
  } catch (err) {
    return failFromSkills(err, 'skill update failed');
  }
}
