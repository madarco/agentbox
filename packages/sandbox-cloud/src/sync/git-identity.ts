import { execa } from 'execa';
import type { CloudBackend, CloudHandle } from '@agentbox/core';
import { bashScript, quoteShellArg } from '../shell.js';

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

/**
 * Configure a cloud box to use git credentials copied INTO it (`git.pushMode=
 * direct` / `--with-credentials`). The secret files themselves (`~/.git-credentials`,
 * the SSH key, gh `hosts.yml`) are dropped by the carry apply path; this sets the
 * git config that makes them take effect:
 *
 * - `credential.helper store` so an HTTPS `git push`/`fetch` reads the token from
 *   the carried `~/.git-credentials`.
 * - `core.sshCommand` with `StrictHostKeyChecking=accept-new` so an SSH remote's
 *   first push doesn't hang on the host-key prompt (the box is non-interactive).
 * - commit signing (SSH format) mirrored from the host, rewriting a host
 *   `user.signingkey` PATH to the box location the key was carried to
 *   (`/home/vscode/.ssh/<basename>`). A non-path (literal `key::…`) value is set
 *   verbatim. GPG-format signing is skipped (v1 copies SSH signing keys only).
 *
 * Idempotent (re-runs on resume). Best-effort: a failure never blocks the box.
 */
export async function seedGitCredentials(
  backend: CloudBackend,
  handle: CloudHandle,
  opts: SeedGitIdentityOptions = {},
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const cmds: string[] = [
    // The credential files rode the carry path, which chowns to a fixed uid
    // (1000). The box's own user is not 1000 on every provider (vercel/e2b use
    // 1001/1002), so re-own the copied creds to whoever WE are — else the box
    // can't read its own 0600 token/keys. Provider-agnostic: uses `id -u`.
    `sudo -n chown -R "$(id -u):$(id -g)" "$HOME/.git-credentials" "$HOME/.ssh" 2>/dev/null || true`,
    `chmod 600 "$HOME/.git-credentials" 2>/dev/null || true`,
    `chmod 700 "$HOME/.ssh" 2>/dev/null || true`,
    `chmod 600 "$HOME"/.ssh/id_* 2>/dev/null || true`,
    `git config --global credential.helper store`,
    `git config --global core.sshCommand ${quoteShellArg('ssh -o StrictHostKeyChecking=accept-new')}`,
  ];

  const gpgsign = (await readHostGitConfig('commit.gpgsign', opts.hostRepo))?.toLowerCase();
  const format = (await readHostGitConfig('gpg.format', opts.hostRepo))?.toLowerCase();
  const signingKey = await readHostGitConfig('user.signingkey', opts.hostRepo);
  if (gpgsign === 'true' && signingKey && format === 'ssh') {
    // Rewrite a filesystem path to the box location the key was carried to; a
    // literal `key::ssh-…` value (or a bare public-key string) is set verbatim.
    const looksLikePath = signingKey.includes('/') && !signingKey.startsWith('key::');
    const boxKey = looksLikePath ? `/home/vscode/.ssh/${signingKey.split('/').pop() ?? ''}` : signingKey;
    cmds.push(`git config --global gpg.format ssh`);
    cmds.push(`git config --global user.signingkey ${quoteShellArg(boxKey)}`);
    // Only enable commit.gpgsign if the private key is usable NON-interactively.
    // A passphrase-protected key can't be decrypted without an agent/askpass in
    // the box, so forcing gpgsign would make EVERY `git commit` fail. Guard on a
    // passphrase-less probe (`ssh-keygen -y -P ''`) and warn if we skip it.
    const priv = looksLikePath
      ? `/home/vscode/.ssh/${(signingKey.split('/').pop() ?? '').replace(/\.pub$/, '')}`
      : boxKey;
    cmds.push(
      `if ssh-keygen -y -P '' -f ${quoteShellArg(priv)} >/dev/null 2>&1; then ` +
        `git config --global commit.gpgsign true; ` +
        `else ` +
        `git config --global --unset commit.gpgsign 2>/dev/null || true; ` +
        `echo "agentbox: signing key ${priv} needs a passphrase — leaving commit signing OFF so in-box commits do not fail" >&2; ` +
        `fi`,
    );
  }

  const r = await backend.exec(handle, bashScript(cmds.join(' && ')));
  if (r.exitCode !== 0) {
    log(`git: credential config failed (exit ${String(r.exitCode)}): ${(r.stderr || r.stdout).trim()}`);
    return;
  }
  log('git: configured box-held credentials (direct push mode)');
}

/** Read a host git config value (effective: system + global + repo-local). */
async function readHostGitConfig(key: string, hostRepo?: string): Promise<string | null> {
  const args = hostRepo ? ['-C', hostRepo, 'config', key] : ['config', key];
  const r = await execa('git', args, { reject: false });
  if (r.exitCode !== 0) return null;
  const value = (r.stdout ?? '').trim();
  return value.length > 0 ? value : null;
}
