import { execa } from 'execa';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface DetectedGitRepo {
  kind: 'root' | 'nested';
  /** Absolute host path of the repo working tree (== `<workspace>` for root). */
  hostMainRepo: string;
  /** Path relative to the workspace where the repo lives. Empty string for root. */
  relPathFromWorkspace: string;
}

/**
 * Look for `.git` directories at the workspace root and at every 1st-level
 * subdirectory. Worktree-form `.git` files (regular file containing
 * `gitdir: …`) are intentionally skipped — turning an existing worktree into
 * another worktree gets weird, and the user case for it is rare.
 *
 * Pure host-side detection: it only tells callers where the repos are. Docker
 * boxes create the worktree inside the container against the bind-mounted
 * `.git/`; cloud boxes clone from a bundle. Either way this is the host probe.
 */
export async function detectGitRepos(workspace: string): Promise<DetectedGitRepo[]> {
  const out: DetectedGitRepo[] = [];
  if (await isGitDir(join(workspace, '.git'))) {
    out.push({ kind: 'root', hostMainRepo: workspace, relPathFromWorkspace: '' });
  }
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(workspace, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const sub = join(workspace, e.name);
    if (await isGitDir(join(sub, '.git'))) {
      out.push({ kind: 'nested', hostMainRepo: sub, relPathFromWorkspace: e.name });
    }
  }
  return out;
}

async function isGitDir(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Pick `<base>`, `<base>-2`, `<base>-3`, … until git reports no such branch
 * exists. Avoids collision when the user reruns `agentbox create -n same-name`
 * after destroying — the destroyed box's branch still lives in the host repo.
 */
export async function pickFreshBranch(hostMainRepo: string, base: string): Promise<string> {
  let candidate = base;
  let suffix = 2;
  while (await branchExists(hostMainRepo, candidate)) {
    candidate = `${base}-${String(suffix++)}`;
    if (suffix > 100) throw new GitWorktreeError(`could not find a free branch name near ${base}`);
  }
  return candidate;
}

async function branchExists(hostMainRepo: string, name: string): Promise<boolean> {
  const result = await execa(
    'git',
    ['-C', hostMainRepo, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`],
    { reject: false },
  );
  return result.exitCode === 0;
}

export class GitWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitWorktreeError';
  }
}
