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
 * Configure a cloud box to use the git credential copied INTO it (`git.pushMode=
 * direct` / `--with-credentials`). The user chose ONE of two shapes at create
 * time and the corresponding secret already rode the carry path; this sets the
 * git config that makes it take effect, driven by which file actually landed:
 *
 * - **token** (`~/.git-credentials` present): `credential.helper store` + a
 *   `url.insteadOf` rewrite so a github SSH-form remote pushes over HTTPS with
 *   the token — the box needs no SSH key. Commits are unsigned.
 * - **ssh** (an `~/.ssh/id_*` key present): `core.sshCommand` accept-new + a
 *   `url.insteadOf` rewrite so an HTTPS remote pushes over SSH, plus commit
 *   signing — but only when the key is usable NON-interactively (a
 *   passphrase-protected key can't sign in the box, and forcing `commit.gpgsign`
 *   would break every commit, so we probe `ssh-keygen -y -P ''` and skip if not).
 *
 * All copied creds are re-owned to the box user first (carry chowns to a fixed
 * uid 1000, but the box user is 1001/1002 on some providers). Idempotent on
 * resume.
 *
 * **Fatal on failure** (throws): this only runs in `git.pushMode=direct`, where a
 * usable credential is the whole point. If the config step fails, or no
 * credential actually landed (a best-effort carry upload dropped it), we must
 * NOT finish the create with a box stamped `AGENTBOX_GIT_DIRECT=1` that can't
 * push — better to fail the create loudly so the user retries.
 */
export async function seedGitCredentials(
  backend: CloudBackend,
  handle: CloudHandle,
  opts: SeedGitIdentityOptions = {},
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const host = await readHostOriginHost(opts.hostRepo);
  const qHost = quoteShellArg(host);

  const httpsKey = quoteShellArg(`url.https://${host}/.insteadOf`);
  const sshKey = quoteShellArg(`url.git@${host}:.insteadOf`);

  // Token mode: force the origin over HTTPS so the carried token authenticates.
  // insteadOf is multi-valued (scp-form `git@h:` AND `ssh://git@h/`), so use
  // --add — a plain `git config` on the same key would overwrite. --unset-all
  // first keeps a resume re-run idempotent (no duplicate values).
  const tokenCfg = [
    `git config --global credential.helper store`,
    `git config --global --unset-all ${httpsKey} 2>/dev/null || true`,
    `git config --global --add ${httpsKey} ${quoteShellArg(`git@${host}:`)}`,
    `git config --global --add ${httpsKey} ${quoteShellArg(`ssh://git@${host}/`)}`,
  ].join(' && ');

  // SSH mode: accept the host key non-interactively, force SSH transport, point
  // ssh at the copied key (which may have a NON-default basename when it came
  // from an `ssh -G` / `IdentityFile`), and enable signing only when the key can
  // sign without a passphrase. Prefer a default id_* key for -i (the common auth
  // key), else the single copied custom key.
  // Joined with `;` (not `&&`): these are independent best-effort config steps,
  // and a false test (e.g. a default key IS present) must not short-circuit the
  // rest.
  const sshCfg = [
    `git config --global --replace-all ${sshKey} ${quoteShellArg(`https://${host}/`)}`,
    `AGB_KEY=$(ls "$HOME"/.ssh/id_ed25519 "$HOME"/.ssh/id_rsa "$HOME"/.ssh/id_ecdsa 2>/dev/null | head -1)`,
    `if [ -z "$AGB_KEY" ]; then AGB_KEY=$(find "$HOME/.ssh" -maxdepth 1 -type f ! -name '*.pub' ! -name 'config' ! -name 'known_hosts*' ! -name 'authorized_keys' 2>/dev/null | head -1); fi`,
    `git config --global core.sshCommand "ssh\${AGB_KEY:+ -i $AGB_KEY} -o StrictHostKeyChecking=accept-new"`,
    await buildSigningSnippet(opts.hostRepo),
  ]
    .filter(Boolean)
    .join('; ');

  const script = [
    // carry chowns to a fixed uid (1000); the box user is 1001/1002 elsewhere.
    // Re-own so the box can read its own 0600 creds. Provider-agnostic.
    `sudo -n chown -R "$(id -u):$(id -g)" "$HOME/.git-credentials" "$HOME/.ssh" 2>/dev/null || true`,
    `chmod 600 "$HOME/.git-credentials" 2>/dev/null || true`,
    `chmod 700 "$HOME/.ssh" 2>/dev/null || true`,
    // Any copied key (default OR custom basename) must be 0600 for ssh.
    `find "$HOME/.ssh" -maxdepth 1 -type f -exec chmod 600 {} + 2>/dev/null || true`,
    `HOST=${qHost}`,
    // Mode comes from the explicit marker the gate wrote (so a stray `carry:`
    // ~/.git-credentials can't flip an SSH-mode box to HTTPS); fall back to file
    // presence for boxes created before the marker existed. SSH mode accepts ANY
    // private key (default OR a custom basename from an `IdentityFile`). Whatever
    // the mode, the matching credential must actually be present — if not, the
    // carry dropped it, so exit non-zero and fail the create rather than stamp a
    // broken direct box.
    `AGB_HAS_KEY() { find "$HOME/.ssh" -maxdepth 1 -type f ! -name '*.pub' ! -name 'config' ! -name 'known_hosts*' ! -name 'authorized_keys' 2>/dev/null | grep -q .; }`,
    `MODE=$(cat "$HOME/.config/agentbox/git-direct-mode" 2>/dev/null)`,
    `if [ -z "$MODE" ]; then if [ -f "$HOME/.git-credentials" ]; then MODE=token; elif AGB_HAS_KEY; then MODE=ssh; fi; fi`,
    `if [ "$MODE" = token ] && [ -f "$HOME/.git-credentials" ]; then ${tokenCfg}; ` +
      `elif [ "$MODE" = ssh ] && AGB_HAS_KEY; then ${sshCfg}; ` +
      `else echo "agentbox: git.pushMode=direct but the chosen credential ($MODE) did not land in the box (carry upload failed?)" >&2; exit 3; fi`,
  ].join('\n');

  const r = await backend.exec(handle, bashScript(script));
  if (r.exitCode !== 0) {
    // Fatal for direct mode — see the doc comment. Fail the create.
    throw new Error(
      `git.pushMode=direct: configuring box-held credentials failed (exit ${String(r.exitCode)}): ${(r.stderr || r.stdout).trim()}`,
    );
  }
  log('git: configured box-held credentials (direct push mode)');
}

/** Bash that enables SSH commit signing iff the host signs and the key is usable. */
async function buildSigningSnippet(hostRepo?: string): Promise<string> {
  const gpgsign = (await readHostGitConfig('commit.gpgsign', hostRepo))?.toLowerCase();
  const format = (await readHostGitConfig('gpg.format', hostRepo))?.toLowerCase();
  const signingKey = await readHostGitConfig('user.signingkey', hostRepo);
  if (gpgsign !== 'true' || !signingKey || format !== 'ssh') return '';
  const looksLikePath = signingKey.includes('/') && !signingKey.startsWith('key::');
  const boxKey = looksLikePath ? `/home/vscode/.ssh/${signingKey.split('/').pop() ?? ''}` : signingKey;
  const priv = looksLikePath
    ? `/home/vscode/.ssh/${(signingKey.split('/').pop() ?? '').replace(/\.pub$/, '')}`
    : boxKey;
  return (
    `git config --global gpg.format ssh && ` +
    `git config --global user.signingkey ${quoteShellArg(boxKey)} && ` +
    // Passphrase-protected keys can't sign non-interactively (no agent in the
    // box); forcing gpgsign would break every commit, so probe first.
    `if ssh-keygen -y -P '' -f ${quoteShellArg(priv)} >/dev/null 2>&1; then ` +
    `git config --global commit.gpgsign true; ` +
    `else ` +
    `git config --global --unset commit.gpgsign 2>/dev/null || true; ` +
    `echo "agentbox: signing key needs a passphrase — leaving commit signing OFF so in-box commits do not fail" >&2; ` +
    `fi`
  );
}

/** Read the host repo's origin URL and extract its host (defaults to github.com). */
async function readHostOriginHost(hostRepo?: string): Promise<string> {
  const args = hostRepo ? ['-C', hostRepo, 'remote', 'get-url', 'origin'] : ['remote', 'get-url', 'origin'];
  const r = await execa('git', args, { reject: false });
  const url = r.exitCode === 0 ? (r.stdout ?? '').trim() : '';
  // scheme://[user@]host[:port]/… , scp-form user@host:… , or bare host.
  const m =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(url) ?? /^(?:[^@/]+@)?([^/:]+):/i.exec(url);
  const host = m?.[1];
  return host && host.length > 0 ? host : 'github.com';
}

/** Read a host git config value (effective: system + global + repo-local). */
async function readHostGitConfig(key: string, hostRepo?: string): Promise<string | null> {
  const args = hostRepo ? ['-C', hostRepo, 'config', key] : ['config', key];
  const r = await execa('git', args, { reject: false });
  if (r.exitCode !== 0) return null;
  const value = (r.stdout ?? '').trim();
  return value.length > 0 ? value : null;
}
