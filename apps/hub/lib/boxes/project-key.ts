// Which project card a box groups under — the pure half, so the rules are
// testable without a hub, a Store, or a filesystem.
//
// A control box builds every box from a per-job clone under
// `$TMPDIR/agentbox-hub-worker-<jobId>` and deletes it as soon as the create
// returns. That path is recorded in two places (the box's `projectRoot` and its
// registration's `worktrees[].hostMainRepo`), and taking either at face value
// produces a project card named after a directory that no longer exists —
// with no origin, no `agentbox.yaml` and no seed. Worse, the card is then a
// projection of that one box, so destroying the box makes the "project"
// disappear. The repo is the durable identity; use it.
import { hashProjectPath } from '@agentbox/config';
import { repoProjectKey } from '@agentbox/relay';
import { deriveRepoLabel, isHubWorkerClone } from '@agentbox/sandbox-core';
import path from 'node:path';

// These three moved to @agentbox/sandbox-core so `apps/cli` can recognize a
// hub-worker clone too (it must not print that dead path in `agentbox ls`).
// Re-exported here because this module is where the hub's own callers look.
export { HUB_WORKER_CLONE_PREFIX, deriveRepoLabel, isHubWorkerClone } from '@agentbox/sandbox-core';

/** The registration fields this needs — a structural subset of `BoxRegistration`. */
export interface ProjectKeyRegistration {
  name: string;
  originUrl?: string | null;
  projectSlug?: string | null;
  worktrees?: { hostMainRepo?: string }[];
}

/**
 * The synthetic project a registered box groups under. The box row and this
 * project MUST share the id, or the dashboard counts the box but renders it
 * under no project card (it groups strictly by `projectId`).
 *
 * Keyed by the box's HOST FOLDER when it has a real one — the same key
 * `agentbox ls` uses locally (`hashProjectPath(projectRoot)`), so a PC box
 * groups by its folder rather than its repo: two folders sharing a git origin
 * stay separate (matching the local model), and the id matches the box's own
 * local project, so adopting it on the PC lands it in the same card.
 *
 * A control box's per-job clone is NOT such a folder, so it falls through to the
 * repo. That identity outlives every box built from it, which is the point: the
 * card stops vanishing when its last box is destroyed.
 */
export function registrationProjectKey(reg: ProjectKeyRegistration): { id: string; repo: string } {
  const hostFolder = reg.worktrees?.[0]?.hostMainRepo;
  if (hostFolder && hostFolder.startsWith('/') && !isHubWorkerClone(hostFolder)) {
    return { id: hashProjectPath(hostFolder), repo: path.basename(hostFolder) };
  }
  // The ORIGIN first, through the one repo-key helper a workspace record uses:
  // the two must agree, or a registered box's project id is absent from its own
  // workspace's `projectIds` and every join through it misses. The slug keys a
  // registration that carries no origin; the label comes from the readable one.
  // Keying on the basename alone would collide two owners' `app` repos.
  const byRepo = reg.originUrl ? repoProjectKey(reg.originUrl) : undefined;
  const repo = reg.originUrl ? deriveRepoLabel(reg.originUrl) : (reg.projectSlug ?? reg.name);
  return { id: byRepo ?? hashProjectPath(reg.projectSlug ?? reg.name), repo };
}
