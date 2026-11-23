// GET /api/v1/history/memory/versions?repo&agent&scope&path — every version of
// one memory file, oldest first, tombstones included.
import { safeMemoryPath } from '@agentbox/core';
import { fail, ok } from '../../../lib/envelope';
import { memoryFileJson, memoryKeyOrFail, memoryOrFail } from '../_memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const memory = memoryOrFail();
  if (memory instanceof Response) return memory;
  const p = new URL(req.url).searchParams;
  const key = memoryKeyOrFail(p);
  if (key instanceof Response) return key;
  const path = safeMemoryPath(p.get('path'));
  if (!path) return fail('invalid_request', 'path is required: a relative memory file path');
  const versions = await memory.versions(key, path);
  if (versions.length === 0) return fail('not_found', `no memory file ${path}`);
  return ok({ ...key, path, versions: versions.map(memoryFileJson) });
}
