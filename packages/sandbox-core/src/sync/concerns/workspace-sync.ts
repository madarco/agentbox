/**
 * `agentbox sync` — host → live box, both legs.
 *
 * A box's workspace is either a git worktree or a plain directory, and the two
 * need different machinery:
 *
 *  - **git leg** — `provider.resyncWorkspace`, which has existed and been
 *    golden-tested since the sync refactor but was reachable only from an
 *    agent-session start after a down→up transition. It merges the host branch
 *    into the box branch and overlays the host's uncommitted + untracked
 *    changes. Nothing here re-implements it.
 *  - **non-git leg** — new. Enumerate the host dir with the shared workspace
 *    excludes, hash each file, ask the box what it has, and copy only what the
 *    box is missing.
 *
 * Both legs keep the same promise: **the box wins.** Nothing in the box is ever
 * overwritten or reset, only added to; a host file the box has changed is
 * skipped and reported. This runs against a live box, so a destructive default
 * would be a data-loss default.
 *
 * Shared by the CLI command and the hub's `POST /api/v1/boxes/:id/sync`, so the
 * web UI and the tray get the same operation.
 */

import type { BoxRecord, Provider } from '@agentbox/core';
import { detectGitRepos } from '../../git-detect.js';
import { boxOverlayPorts, providerBoxFilePorts } from './box-files.js';
import { overlayHostDirIntoBox, workspaceExcludes } from './workspace-files.js';

export interface SyncWorkspaceArgs {
  provider: Provider;
  box: BoxRecord;
  /** In-box workspace dir (default `/workspace`). */
  boxWorkspaceDir?: string;
  /** Default false. Keep `node_modules` in the non-git push. */
  includeNodeModules?: boolean;
  onLog?: (line: string) => void;
}

export interface SyncWorkspaceResult {
  /** Which leg ran. `git` merges; `files` overlays a plain directory. */
  mode: 'git' | 'files';
  /** Paths the box kept its own version of (the host change was skipped). */
  conflicts: string[];
  /** Files copied into the box. Always 0 on the git leg (git reports merges). */
  copied: number;
  /** Per-repo merge/overlay detail, git leg only. */
  repos?: { containerPath: string; mergeConflicts: string[]; overlaySkipped: string[] }[];
}

/**
 * Push the host workspace into a live box. Picks the leg from what the HOST
 * workspace is: a git repo there means the box was seeded as a worktree/clone
 * and the git path applies; anything else is a plain file overlay.
 */
export async function syncWorkspaceToBox(args: SyncWorkspaceArgs): Promise<SyncWorkspaceResult> {
  const log = args.onLog ?? ((): void => {});
  const boxDir = args.boxWorkspaceDir ?? '/workspace';
  const repos = await detectGitRepos(args.box.workspacePath);

  if (repos.length > 0) {
    if (!args.provider.resyncWorkspace) {
      throw new Error(
        `provider '${args.provider.name}' cannot resync a git workspace into a live box`,
      );
    }
    log('syncing git workspace (merge host branch + overlay uncommitted/untracked)');
    const result = await args.provider.resyncWorkspace(args.box, log);
    const conflicts = result.repos.flatMap((r) => [...r.mergeConflicts, ...r.overlaySkipped]);
    return { mode: 'git', conflicts, copied: 0, repos: result.repos };
  }

  log('syncing non-git workspace (file overlay; the box wins on conflict)');
  const ports = providerBoxFilePorts(args.provider, args.box);
  const overlay = await overlayHostDirIntoBox({
    hostDir: args.box.workspacePath,
    excludes: workspaceExcludes({ includeNodeModules: args.includeNodeModules }),
    ports: boxOverlayPorts(ports, boxDir),
    onLog: log,
  });
  return { mode: 'files', conflicts: overlay.skipped, copied: overlay.copied.length };
}
