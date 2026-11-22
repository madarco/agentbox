// GET /api/v1/history/memory/file?repo&agent&scope&path&version — one version
// of a memory file (default: the latest), content base64.
import { safeMemoryPath } from '@agentbox/core';
import { fail, ok } from '../../../lib/envelope';
import { intParam } from '../../_service';
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
  const version = p.get('version') === null ? undefined : intParam(p.get('version'), 0, 1);
  if (version === null) return fail('invalid_request', 'version must be a positive integer');
  const hit = await memory.file(key, path, version);
  if (!hit) {
    return fail(
      'not_found',
      version === undefined
        ? `no live memory file ${path}`
        : `no version ${String(version)} of ${path}`,
    );
  }
  return ok({ ...key, file: memoryFileJson(hit.view), content: hit.bytes.toString('base64') });
}
