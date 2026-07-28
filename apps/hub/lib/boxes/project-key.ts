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
import path from 'node:path';

/**
 * Prefix of the per-job clone `makeHubCreateBox` builds from. Exported so the
 * producer (`hub-worker.ts`'s `tmpDir`) and these consumers can't drift — a
 * rename on one side would otherwise silently resurrect the ghost cards.
 */
export const HUB_WORKER_CLONE_PREFIX = 'agentbox-hub-worker-';

/**
 * True for a control box's throwaway per-job checkout.
 *
 * Deliberately a NAME test, not an existence test: during the minute a create
 * is running the directory is still there, and a PC-created box's
 * `hostMainRepo` legitimately doesn't exist on the control box while still
 * being a real, durable folder on the PC that we do want to group by.
 */
export function isHubWorkerClone(dir: string): boolean {
  return path.basename(dir).startsWith(HUB_WORKER_CLONE_PREFIX);
}

/** `owner/repo` from a clone URL, else the URL unchanged. */
export function deriveRepoLabel(originUrl: string): string {
  const m = /[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(originUrl);
  return m?.[1] ?? originUrl;
}

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
  // Identity from the unambiguous slug/origin; the label from the readable one.
  // Keying on the basename alone would collide two owners' `app` repos.
  const key = reg.projectSlug ?? reg.originUrl ?? reg.name;
  const repo = reg.originUrl ? deriveRepoLabel(reg.originUrl) : (reg.projectSlug ?? reg.name);
  return { id: hashProjectPath(key), repo };
}
