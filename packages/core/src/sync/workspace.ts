/**
 * Workspace-resync contracts — the provider-neutral I/O a session-restart
 * workspace resync needs, so the orchestration (`resyncWorkspace`, implemented
 * in `@agentbox/sandbox-core` `sync/concerns/git.ts`) is a pure function of these
 * ports and golden-tests against a scripted fake.
 *
 * Docker implements every port with its current host-git / `docker exec`
 * commands (byte-identical to the pre-refactor `resyncWorkspaceFromHost`). A
 * cloud implementation (deferred — the cloud "Phase 2" gap) swaps the box-side
 * ports onto `CloudSyncTransport` while reusing the identical host-git ports;
 * host git is provider-neutral (it's the host's own repo either way).
 *
 * Do NOT over-build: ship the docker implementation; add the cloud one when the
 * gap is closed (and smoke-tested), not before.
 */

/** One box worktree to resync: its in-box path, the host repo it tracks, and the box's per-box branch. */
export interface ResyncWorktree {
  /** Absolute in-box worktree path (what `/workspace` points at). */
  containerPath: string;
  /** Host main repo whose branch/uncommitted/untracked state we merge in. */
  hostMainRepo: string;
  /** The box's per-box branch (merge target; `hostRef === branch` ⇒ merging self, skipped). */
  branch: string;
}

/** Exit/stdout/stderr of one box-side git invocation. */
export interface ResyncExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Per-repo outcome of a resync — the conflicts where the box's version was kept. */
export interface RepoResyncResult {
  containerPath: string;
  /** Paths where merging host commits conflicted; box version kept (host change shadowed). */
  mergeConflicts: string[];
  /** Paths where overlaying host uncommitted/untracked was skipped to keep the box version. */
  overlaySkipped: string[];
}

/**
 * The I/O surface a workspace resync drives. Host-side ports are read-only on the
 * host repo (no worktree side effects); box-side ports mutate the box worktree.
 */
export interface WorkspaceResyncPorts {
  // --- host repo (read-only host git) ---
  /** Host's checked-out branch (symbolic-ref) or, when detached, HEAD's sha. null if unresolvable. */
  resolveHostRef(hostMainRepo: string): Promise<string | null>;
  /** `git stash create` sha for the host's uncommitted tracked changes, or null when clean/failed. */
  createHostStash(hostMainRepo: string): Promise<string | null>;
  /** Host untracked files, gitignore-respecting (`ls-files --others --exclude-standard`). */
  listHostUntracked(hostMainRepo: string): Promise<string[]>;
  /** sha256 of a host file's contents (path relative to the repo). Throws if unreadable / vanished. */
  hashHostFile(hostMainRepo: string, relPath: string): Promise<string>;
  /** Pack the given host files (relative paths) into a tar buffer, or null on a pack failure. */
  packHostFiles(hostMainRepo: string, relPaths: string[]): Promise<Buffer | null>;
  // --- box worktree ---
  /** Run git inside the box worktree as the box agent user. */
  boxGit(worktreePath: string, args: string[]): Promise<ResyncExecResult>;
  /**
   * Probe the box for each host-untracked path: a token per path that EXISTS in
   * the box — the sha256 of its contents, or the non-regular sentinel (`'-'`) for
   * a dir/symlink. Absent paths are omitted from the map.
   */
  probeUntrackedTokens(worktreePath: string, relPaths: string[]): Promise<Map<string, string>>;
  /** Extract a host-packed tar into the box worktree as the box agent user. */
  applyTarToBox(worktreePath: string, tar: Buffer): Promise<void>;
}
