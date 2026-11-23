// Shared by the /api/v1/history/memory routes: the service the custom server
// built, and the (repo, agent, scope) a request names.
import { repoKey } from '@agentbox/config';
import type { MemoryFileView, MemoryKey, MemoryService } from '@/lib/backend/history-memory';
import { fail } from '../../lib/envelope';

export function memoryOrFail(): MemoryService | Response {
  const memory = globalThis.__AGENTBOX_HUB_MEMORY;
  if (!memory) return fail('backend_unavailable', 'agent memory is not enabled on this hub');
  return memory;
}

/**
 * `repo` in any spelling (`git@github.com:o/r.git`, `https://github.com/o/r`,
 * the key itself, or a `local:<machine>:<path>` key) plus `agent` (default
 * `claude`) and `scope` (default `project`).
 */
export function memoryKeyOrFail(p: URLSearchParams): MemoryKey | Response {
  const raw = p.get('repo')?.trim() ?? '';
  const key = raw.startsWith('local:') ? raw : repoKey(raw);
  if (!key) return fail('invalid_request', 'repo is required: a git remote URL or a repo key');
  const scope = p.get('scope') ?? 'project';
  if (scope !== 'project' && scope !== 'global') {
    return fail('invalid_request', 'scope must be project or global');
  }
  return { repoKey: key, agent: p.get('agent') || 'claude', scope };
}

export function memoryFileJson(v: MemoryFileView): Record<string, unknown> {
  return { ...v, updatedAt: new Date(v.updatedAt).toISOString() };
}
