import { parseGitRemote, repoSlugFromRemote, toAuthedHttpsUrl } from './git-pat.js';
import type { GitHubAppLeaser } from './github-app.js';
import type { BoxRegistration, GitRpcResult } from './types.js';

/**
 * Mint a repo-scoped GitHub-App installation token for a box and package it as
 * a `{exitCode,stdout,stderr}` result whose `stdout` is the lease JSON
 * (`{ token, expiresAt, remoteUrl, repo }`). Shared by the node relay
 * (server.ts) and the hosted-plane handler (core/handler.ts).
 *
 * The repo is resolved from the box's REGISTERED origin URL — never from
 * box-supplied params — so a box can only ever lease a token for its own repo.
 */
export async function leaseTokenResult(
  leaser: GitHubAppLeaser | null,
  reg: BoxRegistration,
): Promise<GitRpcResult> {
  if (!leaser) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: 'git.lease-token: no GitHub App configured on this relay\n',
    };
  }
  const origin = reg.originUrl;
  if (!origin) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: `git.lease-token: box ${reg.boxId} has no registered origin URL\n`,
    };
  }
  let owner = '';
  let repo = '';
  let slug = '';
  try {
    const { path } = parseGitRemote(origin);
    const [o, r] = path.replace(/\.git$/, '').split('/');
    owner = o ?? '';
    repo = r ?? '';
    slug = repoSlugFromRemote(origin);
  } catch {
    return { exitCode: 65, stdout: '', stderr: `git.lease-token: unrecognized origin ${origin}\n` };
  }
  if (!owner || !repo) {
    return {
      exitCode: 65,
      stdout: '',
      stderr: `git.lease-token: cannot derive owner/repo from ${origin}\n`,
    };
  }
  try {
    const leased = await leaser.leaseRepoToken(owner, repo);
    const payload = {
      token: leased.token,
      expiresAt: leased.expiresAt,
      remoteUrl: toAuthedHttpsUrl(origin, leased.token),
      repo: slug,
    };
    return { exitCode: 0, stdout: JSON.stringify(payload), stderr: '' };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `git.lease-token: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }
}
