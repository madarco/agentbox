import type { BoxRegistration, BoxWorktree } from './types.js';

/**
 * Resolve `containerPath` (a path inside the box) to the registered worktree
 * whose `hostMainRepo` + `branch` the relay should act on. `/workspace` maps to
 * the root repo; `/workspace/<sub>` maps to a nested repo when registered
 * (longest prefix wins). Pure — shared by the node relay (server.ts) and the
 * hosted-plane handler (core/handler.ts).
 */
export function resolveWorktree(reg: BoxRegistration, containerPath: string): BoxWorktree | null {
  const trees = reg.worktrees ?? [];
  if (trees.length === 0) return null;
  const exact = trees.find((w) => w.containerPath === containerPath);
  if (exact) return exact;
  const prefixMatches = trees
    .filter(
      (w) => containerPath === w.containerPath || containerPath.startsWith(w.containerPath + '/'),
    )
    .sort((a, b) => b.containerPath.length - a.containerPath.length);
  return prefixMatches[0] ?? trees.find((w) => w.containerPath === '/workspace') ?? null;
}
