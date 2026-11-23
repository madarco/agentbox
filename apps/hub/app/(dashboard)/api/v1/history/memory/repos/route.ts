// GET /api/v1/history/memory/repos — every (repo, agent, scope) the hub holds
// memory for, newest write first, with its live file and version counts.
import { ok } from '../../../lib/envelope';
import { memoryOrFail } from '../_memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const memory = memoryOrFail();
  if (memory instanceof Response) return memory;
  return ok({
    sets: (await memory.sets()).map((s) => ({
      ...s,
      updatedAt: new Date(s.updatedAt).toISOString(),
    })),
  });
}
