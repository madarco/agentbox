import { execa } from 'execa';
import type { CloudBackend, CloudHandle } from '@agentbox/core';
import { bashScript, quoteShellArg } from './shell.js';

export interface SeedGitIdentityOptions {
  /** Host repo dir to read the effective `user.name`/`user.email` from. */
  hostRepo?: string;
  onLog?: (line: string) => void;
}

/** Generic fallback so a box always has a usable committer identity. */
const FALLBACK_NAME = 'agentbox';
const FALLBACK_EMAIL = 'agentbox@users.noreply.github.com';

/**
 * Configure a git committer identity inside a cloud box.
 *
 * Docker boxes bind-mount the host `~/.gitconfig`, so they inherit the user's
 * identity for free. Cloud boxes (vercel/hetzner/daytona) can't bind-mount and
 * otherwise have *no* identity — which breaks any in-box commit: the agent's
 * own `git commit`, and the merge commit `agentbox git pull` writes. We mirror
 * the Docker behavior here: author as the host user when their identity is
 * resolvable, and fall back to a generic agentbox identity so commits never
 * fail with "Committer identity unknown".
 *
 * Reads the *effective* identity from the host repo (`git -C <repo> config
 * user.name`), so a repo-local override is honored just like a normal local
 * commit would. Sets `--global` for the box's agent user (cloud `exec` runs as
 * that user), which is where the in-box merge / agent commits look it up.
 *
 * Note: the git-lfs `filter.lfs.*` config is intentionally NOT seeded here — it
 * is registered system-wide in each base image (`git lfs install --system`, see
 * the provider install scripts / Dockerfile.box), so an LFS checkout smudges
 * without any per-box config. The objects themselves are seeded host-side by
 * `seedCloneLfsObjects` in workspace-seed.ts.
 */
export async function seedGitIdentity(
  backend: CloudBackend,
  handle: CloudHandle,
  opts: SeedGitIdentityOptions = {},
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const name = (await readHostGitConfig('user.name', opts.hostRepo)) ?? FALLBACK_NAME;
  const email = (await readHostGitConfig('user.email', opts.hostRepo)) ?? FALLBACK_EMAIL;

  const script =
    `git config --global user.name ${quoteShellArg(name)} && ` +
    `git config --global user.email ${quoteShellArg(email)}`;
  const r = await backend.exec(handle, bashScript(script));
  if (r.exitCode !== 0) {
    // Non-fatal: the box still boots; the user just sees the identity error on
    // the next commit, same as before this step existed.
    log(`git: identity config failed (exit ${String(r.exitCode)}): ${(r.stderr || r.stdout).trim()}`);
    return;
  }
  log(`git: configured committer identity ${name} <${email}>`);
}

/** Read a host git config value (effective: system + global + repo-local). */
async function readHostGitConfig(key: string, hostRepo?: string): Promise<string | null> {
  const args = hostRepo ? ['-C', hostRepo, 'config', key] : ['config', key];
  const r = await execa('git', args, { reject: false });
  if (r.exitCode !== 0) return null;
  const value = (r.stdout ?? '').trim();
  return value.length > 0 ? value : null;
}
