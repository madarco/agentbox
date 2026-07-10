import { chmod, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execa } from 'execa';
import { parseGitRemote } from '@agentbox/relay';
import type { ResolvedCarryEntry } from '@agentbox/core';
import { log, select } from './prompt.js';

/**
 * Host-side gate for `git.pushMode=direct` (`--with-credentials`): detect the
 * git credentials this box needs to push/pull/sign on its own, confirm the copy
 * with a loud security warning, and hand back carry entries (secret files at
 * mode 0600, owned by the box `vscode` user) that ride the normal carry apply
 * path into the box.
 *
 * This deliberately breaks AgentBox's usual "credentials never enter the box"
 * invariant — the whole point of `direct` mode is a box that works with your PC
 * off, which requires it to hold real credentials. So the prompt is explicit and
 * the non-TTY path fails closed (mirrors the `carry:` gate), never silently
 * copying secrets.
 */

const BOX_HOME = '/home/vscode';
const BOX_UID = 1000;

export interface GitCredsGateArgs {
  /** Absolute project root (the git repo whose origin the box pushes to). */
  projectRoot: string;
  /** Generic `-y/--yes` — does NOT auto-approve the copy (same rule as carry). */
  yes: boolean;
  /** `--with-credentials-yes` or AGENTBOX_WITH_CREDENTIALS_YES=1 — auto-approves. */
  withCredentialsYes?: boolean;
  onLog?: (line: string) => void;
  /** Test seam. */
  isTTY?: boolean;
}

export type GitCredsGateResult =
  | { decision: 'approve'; entries: ResolvedCarryEntry[] }
  | { decision: 'skip'; entries: [] }
  | { decision: 'cancel' };

/** One credential we plan to copy, for the prompt (never holds the secret). */
interface CredPlanItem {
  /** Human label shown in the prompt (no secret material). */
  label: string;
  /** Box destination path (`~/…`). */
  dest: string;
}

interface CredPlan {
  entries: ResolvedCarryEntry[];
  items: CredPlanItem[];
}

/** Run a git command in the repo, returning trimmed stdout ('' on failure). */
async function git(projectRoot: string, args: string[], opts?: { input?: string }): Promise<string> {
  try {
    const r = await execa('git', ['-C', projectRoot, ...args], {
      input: opts?.input,
      reject: false,
    });
    return r.exitCode === 0 ? (r.stdout ?? '').trim() : '';
  } catch {
    return '';
  }
}

/** True when the origin URL is an HTTPS remote (vs scp/ssh). */
function isHttpsRemote(origin: string): boolean {
  return /^https?:\/\//i.test(origin.trim());
}

/**
 * Ask git's configured credential helper for the token backing an HTTPS remote
 * (works across osxkeychain / store / manager). Falls back to `gh auth token`.
 * Returns `{ username, password }` or null.
 */
async function fillHttpsToken(
  projectRoot: string,
  host: string,
): Promise<{ username: string; password: string } | null> {
  const filled = await git(projectRoot, ['credential', 'fill'], {
    input: `protocol=https\nhost=${host}\n\n`,
  });
  if (filled) {
    const username = /^username=(.*)$/m.exec(filled)?.[1] ?? '';
    const password = /^password=(.*)$/m.exec(filled)?.[1] ?? '';
    if (password) return { username: username || 'x-access-token', password };
  }
  // gh fallback (github.com only).
  if (host.toLowerCase() === 'github.com') {
    try {
      const r = await execa('gh', ['auth', 'token'], { reject: false });
      const token = (r.stdout ?? '').trim();
      if (r.exitCode === 0 && token) return { username: 'x-access-token', password: token };
    } catch {
      /* gh not installed / not logged in */
    }
  }
  return null;
}

/** Resolve the SSH identity file ssh would use for `host` (via `ssh -G`). */
async function resolveSshIdentity(host: string): Promise<string | null> {
  const home = homedir();
  try {
    const r = await execa('ssh', ['-G', host], { reject: false });
    if (r.exitCode === 0) {
      for (const line of (r.stdout ?? '').split('\n')) {
        const m = /^identityfile\s+(.+)$/i.exec(line.trim());
        if (!m) continue;
        const p = m[1]!.replace(/^~(?=\/)/, home);
        if (await fileExists(p)) return p;
      }
    }
  } catch {
    /* fall through to defaults */
  }
  for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
    const p = join(home, '.ssh', name);
    if (await fileExists(p)) return p;
  }
  return null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Given a path to either half of an SSH key pair (private key or `.pub`),
 * synthesize carry entries for BOTH the private key and the public key into
 * `~/.ssh/`, skipping any already queued. Copying the private key is essential:
 * SSH auth AND SSH commit signing both need it — a lone `.pub` can't sign or
 * authenticate. Returns the box path of the private key (for signingkey rewrite).
 */
async function pushKeyPair(
  keyPath: string,
  entries: ResolvedCarryEntry[],
  items: CredPlanItem[],
  labelKind: string,
): Promise<string | null> {
  const priv = keyPath.endsWith('.pub') ? keyPath.slice(0, -4) : keyPath;
  const pub = `${priv}.pub`;
  let copiedPriv: string | null = null;
  if (await fileExists(priv)) {
    const name = basename(priv);
    if (!entries.some((e) => e.rawDest === `~/.ssh/${name}`)) {
      entries.push(await fileEntry(priv, `~/.ssh/${name}`));
      items.push({ label: `${labelKind} ${priv.replace(homedir(), '~')}`, dest: `~/.ssh/${name}` });
    }
    copiedPriv = `${BOX_HOME}/.ssh/${name}`;
  }
  if (await fileExists(pub)) {
    const pubName = basename(pub);
    if (!entries.some((e) => e.rawDest === `~/.ssh/${pubName}`)) {
      entries.push(await fileEntry(pub, `~/.ssh/${pubName}`));
    }
  }
  return copiedPriv;
}

/** A carry entry for an existing host file, mode 0600, owned by the box user. */
async function fileEntry(absSrc: string, dest: string): Promise<ResolvedCarryEntry> {
  const bytes = (await stat(absSrc)).size;
  return {
    rawSrc: absSrc.replace(homedir(), '~'),
    rawDest: dest,
    absSrc,
    absDest: dest.replace(/^~(?=\/)/, BOX_HOME),
    kind: 'file',
    bytes,
    mode: 0o600,
    user: BOX_UID,
    optional: false,
  } as ResolvedCarryEntry;
}

/** A carry entry for freshly-rendered secret content written to a temp file. */
async function contentEntry(
  tmpDir: string,
  fileName: string,
  content: string,
  dest: string,
  label: string,
): Promise<{ entry: ResolvedCarryEntry; label: string }> {
  const absSrc = join(tmpDir, fileName);
  await writeFile(absSrc, content, { mode: 0o600 });
  await chmod(absSrc, 0o600);
  const bytes = Buffer.byteLength(content);
  return {
    label,
    entry: {
      rawSrc: label,
      rawDest: dest,
      absSrc,
      absDest: dest.replace(/^~(?=\/)/, BOX_HOME),
      kind: 'file',
      bytes,
      mode: 0o600,
      user: BOX_UID,
      optional: false,
    } as ResolvedCarryEntry,
  };
}

/**
 * Build the credential-copy plan from the repo's origin. HTTPS remotes get a
 * `~/.git-credentials` (+ gh `hosts.yml` for `gh pr create`); SSH remotes get
 * the identity key. Commit signing (SSH format) copies the signing key too.
 */
async function planGitCredentials(projectRoot: string, onLog: (l: string) => void): Promise<CredPlan> {
  const origin = await git(projectRoot, ['remote', 'get-url', 'origin']);
  if (!origin) {
    onLog('with-credentials: repo has no origin remote; nothing to copy');
    return { entries: [], items: [] };
  }
  let host = 'github.com';
  try {
    host = parseGitRemote(origin).host;
  } catch {
    /* keep default */
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'agentbox-gitcreds-'));
  await chmod(tmpDir, 0o700);

  const entries: ResolvedCarryEntry[] = [];
  const items: CredPlanItem[] = [];

  if (isHttpsRemote(origin)) {
    const creds = await fillHttpsToken(projectRoot, host);
    if (creds) {
      const line = `https://${encodeURIComponent(creds.username)}:${encodeURIComponent(creds.password)}@${host}`;
      const gitCred = await contentEntry(
        tmpDir,
        'git-credentials',
        `${line}\n`,
        '~/.git-credentials',
        `git token for ${host} (from your credential helper)`,
      );
      entries.push(gitCred.entry);
      items.push({ label: gitCred.label, dest: gitCred.entry.rawDest });
      // NOTE: `gh` (PR create/view/…) is intentionally NOT wired for direct
      // mode in v1 — the box ships only the relay `gh` shim, no real `gh`
      // binary, so PR ops keep routing through the host relay (need the PC on,
      // like cp/download). Baking `gh` or an API-based PR creator is a follow-up.
    } else {
      onLog(`with-credentials: could not obtain a token for ${host} (credential helper + gh both empty)`);
    }
  } else {
    // SSH remote: copy the identity key ssh would use (private + public).
    const key = await resolveSshIdentity(host);
    if (key) {
      await pushKeyPair(key, entries, items, 'SSH key');
    } else {
      onLog(`with-credentials: no SSH identity found for ${host}`);
    }
  }

  // Commit signing (SSH format): copy the signing key so in-box commits sign.
  const gpgsign = (await git(projectRoot, ['config', '--get', 'commit.gpgsign'])).toLowerCase();
  const format = (await git(projectRoot, ['config', '--get', 'gpg.format'])).toLowerCase();
  const signingKey = await git(projectRoot, ['config', '--get', 'user.signingkey']);
  if (gpgsign === 'true' && signingKey) {
    if (format === 'ssh') {
      // user.signingkey may be a path (often the `.pub`), or a literal `key::…`
      // value. For a path, copy the whole pair — signing needs the PRIVATE key,
      // even when signingkey names the `.pub`.
      const path = signingKey.replace(/^~(?=\/)/, homedir());
      if (path.includes('/') && (await fileExists(path))) {
        await pushKeyPair(path, entries, items, 'SSH signing key');
      }
    } else {
      onLog(
        `with-credentials: commit signing uses gpg.format=${format || 'openpgp'} — GPG signing keys are not copied (v1 supports SSH signing only); in-box commits will be unsigned`,
      );
    }
  }

  return { entries, items };
}

/** Render the confirmation table + security warning. */
function printSummary(items: CredPlanItem[]): void {
  const destW = Math.max(4, ...items.map((i) => i.dest.length));
  const rows = [`  ${pad('dest', destW)}   what`];
  for (const i of items) rows.push(`  ${pad(i.dest, destW)}   ${i.label}`);
  log.message(rows.join('\n'));
  log.warn(
    'These credentials will be COPIED INTO the box so it can push/pull/sign with your PC off.\n' +
      'Danger: they then live inside the box (its vscode user has passwordless sudo — no boundary\n' +
      'there) and are captured in any snapshot/checkpoint of the box. Only do this for a box you\n' +
      'trust to keep running unattended.',
  );
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

/**
 * Run the git-credentials gate once for a `create`/launcher command in
 * `git.pushMode=direct`. Returns the carry entries to merge into the box's
 * carry payload (empty on skip), or signals cancel.
 */
export async function runGitCredsGate(args: GitCredsGateArgs): Promise<GitCredsGateResult> {
  const onLog = args.onLog ?? (() => {});
  const plan = await planGitCredentials(args.projectRoot, onLog);
  if (plan.entries.length === 0) {
    // Nothing to copy — direct mode can't work, but that's a user-visible
    // warning, not a hard failure of the create.
    log.warn(
      'with-credentials: found no git credentials to copy (no reachable token and no SSH key). ' +
        'The box will not be able to push on its own.',
    );
    return { decision: 'skip', entries: [] };
  }

  const tty = args.isTTY ?? process.stdin.isTTY;
  const autoYes = args.withCredentialsYes ?? process.env.AGENTBOX_WITH_CREDENTIALS_YES === '1';

  if (!autoYes) {
    if (!tty) {
      throw new Error(
        'with-credentials: requires approval but stdin is not a TTY and --with-credentials-yes was not set. ' +
          'Set AGENTBOX_WITH_CREDENTIALS_YES=1 to opt in to copying your git credentials into this box.',
      );
    }
    printSummary(plan.items);
    const choice = await select<'approve' | 'skip-this-run' | 'cancel'>({
      message: 'Copy these git credentials into the box?',
      options: [
        { value: 'approve', label: 'yes' },
        { value: 'skip-this-run', label: 'skip' },
        { value: 'cancel', label: 'cancel' },
      ],
      initialValue: 'approve',
    });
    if (choice === 'cancel') return { decision: 'cancel' };
    if (choice === 'skip-this-run') return { decision: 'skip', entries: [] };
  }

  onLog(`with-credentials: copying ${String(plan.entries.length)} credential file(s) into the box`);
  return { decision: 'approve', entries: plan.entries };
}

/**
 * Shared create-path helper: when `pushMode === 'direct'`, run the gate and
 * return `existing` carry entries with the approved credential files appended;
 * on cancel, log + call `onClose` + exit(0); on hard error, log + exit(1). When
 * not in direct mode, returns `existing` untouched. Used by `create` and every
 * agent launcher so `--with-credentials` behaves identically everywhere.
 */
export async function resolveGitCredsCarry(args: {
  pushMode: string;
  projectRoot: string;
  existing: ResolvedCarryEntry[];
  yes: boolean;
  withCredentialsYes?: boolean;
  onLog?: (line: string) => void;
  onClose?: () => void;
}): Promise<ResolvedCarryEntry[]> {
  if (args.pushMode !== 'direct') return args.existing;
  try {
    const gate = await runGitCredsGate({
      projectRoot: args.projectRoot,
      yes: args.yes,
      withCredentialsYes: args.withCredentialsYes,
      onLog: args.onLog,
    });
    if (gate.decision === 'cancel') {
      log.warn('with-credentials: cancelled — not creating the box');
      args.onClose?.();
      process.exit(0);
    }
    return gate.decision === 'approve' ? [...args.existing, ...gate.entries] : args.existing;
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    args.onClose?.();
    process.exit(1);
  }
}
