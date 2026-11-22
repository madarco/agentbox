// GET /api/v1/history/memory?repo&agent&scope — the live memory files of one
// repo's agent: the latest version of each path, tombstoned paths left out.
import { ok } from '../../lib/envelope';
import { memoryFileJson, memoryKeyOrFail, memoryOrFail } from './_memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const memory = memoryOrFail();
  if (memory instanceof Response) return memory;
  const key = memoryKeyOrFail(new URL(req.url).searchParams);
  if (key instanceof Response) return key;
  return ok({ ...key, files: (await memory.list(key)).map(memoryFileJson) });
}
