import { existsSync } from 'node:fs';
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

/**
 * Reject host-side git RPCs against a worktree with no usable host repo. A box
 * created by the control-box worker registers its `hostMainRepo` as the
 * create-time seed clone — a temp dir deleted after create — so `git -C <that>`
 * would fail cryptically. Returns an actionable error string for such a
 * worktree, or `null` when the host repo exists. Pure aside from the fs check,
 * so it is unit-testable with a real/fake directory.
 */
export function hostRepoUnavailableReason(
  worktree: BoxWorktree,
  boxId: string,
  op: string,
): string | null {
  if (worktree.hostMainRepo.length > 0 && existsSync(worktree.hostMainRepo)) return null;
  return (
    `host-side ${op} is unavailable for box ${boxId}: its host repo ` +
    `(${worktree.hostMainRepo || '<unset>'}) does not exist on this host. ` +
    `Boxes created by the control-box worker have no host working copy — ` +
    `push from inside the box (leased) or adopt the box on this host first.`
  );
}
