// GET /api/v1/history/memory?repo&agent&scope&deleted — the live memory files
// of one repo's agent: the latest version of each path. Tombstoned paths are
// left out unless `deleted=1`, which lists them with `deleted: true`.
import { ok } from '../../lib/envelope';
import { memoryFileJson, memoryKeyOrFail, memoryOrFail } from './_memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const memory = memoryOrFail();
  if (memory instanceof Response) return memory;
  const p = new URL(req.url).searchParams;
  const key = memoryKeyOrFail(p);
  if (key instanceof Response) return key;
  const includeDeleted = p.get('deleted') === '1' || p.get('deleted') === 'true';
  return ok({ ...key, files: (await memory.list(key, { includeDeleted })).map(memoryFileJson) });
}
