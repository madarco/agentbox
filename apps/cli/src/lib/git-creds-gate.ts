import { chmod, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execa } from 'execa';
import { parseGitRemote } from '@agentbox/relay';
import type { ResolvedCarryEntry } from '@agentbox/core';
import { log, select } from './prompt.js';

/**
 * Host-side gate for `git.pushMode=direct` (`--with-credentials`): the box needs
 * ONE credential to push on its own. A human MUST pick which — a GitHub token
 * (push over HTTPS, commits unsigned, smallest exposure) or their SSH private
 * key (push over SSH + sign commits, but the riskiest secret) — at an
 * interactive prompt, and we hand back carry entries (0600, box-user owned) that
 * ride the normal carry apply path.
 *
 * This deliberately breaks AgentBox's usual "credentials never enter the box"
 * invariant, so the safety bar is deliberately high: copying a credential
 * requires a live TTY and an explicit in-prompt choice. There is intentionally
 * NO non-interactive path — no flag value, no env var, no `-y` — so automation,
 * CI, and the `-i` queue can't copy a secret without a human present.
 */

const BOX_HOME = '/home/vscode';
const BOX_UID = 1000;

/** Which credential the box carries to push on its own. */
type GitCredsMode = 'token' | 'ssh';

export interface GitCredsGateArgs {
  /** Absolute project root (the git repo whose origin the box pushes to). */
  projectRoot: string;
  onLog?: (line: string) => void;
  /** Test seam. */
  isTTY?: boolean;
}

export type GitCredsGateResult =
  | { decision: 'approve'; entries: ResolvedCarryEntry[] }
  | { decision: 'skip'; entries: [] }
  | { decision: 'cancel' };

/** One credential we plan to copy, for the summary (never holds the secret). */
interface CredPlanItem {
  label: string;
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

/** The host the box will push to (derived from origin; defaults to github.com). */
async function originHost(projectRoot: string): Promise<string | null> {
  const origin = await git(projectRoot, ['remote', 'get-url', 'origin']);
  if (!origin) return null;
  try {
    return parseGitRemote(origin).host;
  } catch {
    return 'github.com';
  }
}

/**
 * Ask git's configured credential helper for the token backing an HTTPS remote
 * (works across osxkeychain / store / manager). Falls back to `gh auth token`.
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
): Promise<ResolvedCarryEntry> {
  const absSrc = join(tmpDir, fileName);
  await writeFile(absSrc, content, { mode: 0o600 });
  await chmod(absSrc, 0o600);
  return {
    rawSrc: fileName,
    rawDest: dest,
    absSrc,
    absDest: dest.replace(/^~(?=\/)/, BOX_HOME),
    kind: 'file',
    bytes: Buffer.byteLength(content),
    mode: 0o600,
    user: BOX_UID,
    optional: false,
  } as ResolvedCarryEntry;
}

/**
 * Given a path to either half of an SSH key pair, synthesize carry entries for
 * BOTH the private and public key into `~/.ssh/`, skipping duplicates. Copying
 * the private key is essential: SSH auth AND signing both need it.
 */
async function pushKeyPair(
  keyPath: string,
  entries: ResolvedCarryEntry[],
  items: CredPlanItem[],
  labelKind: string,
): Promise<void> {
  const priv = keyPath.endsWith('.pub') ? keyPath.slice(0, -4) : keyPath;
  const pub = `${priv}.pub`;
  if (await fileExists(priv)) {
    const name = basename(priv);
    if (!entries.some((e) => e.rawDest === `~/.ssh/${name}`)) {
      entries.push(await fileEntry(priv, `~/.ssh/${name}`));
      items.push({ label: `${labelKind} ${priv.replace(homedir(), '~')}`, dest: `~/.ssh/${name}` });
    }
  }
  if (await fileExists(pub)) {
    const pubName = basename(pub);
    if (!entries.some((e) => e.rawDest === `~/.ssh/${pubName}`)) {
      entries.push(await fileEntry(pub, `~/.ssh/${pubName}`));
    }
  }
}

/** Token plan: copy just `~/.git-credentials` (box pushes over HTTPS). */
async function planTokenCreds(projectRoot: string, onLog: (l: string) => void): Promise<CredPlan> {
  const host = (await originHost(projectRoot)) ?? 'github.com';
  const creds = await fillHttpsToken(projectRoot, host);
  if (!creds) {
    onLog(`with-credentials: could not obtain a token for ${host} (credential helper + gh both empty)`);
    return { entries: [], items: [] };
  }
  const tmpDir = await mkdtemp(join(tmpdir(), 'agentbox-gitcreds-'));
  await chmod(tmpDir, 0o700);
  const line = `https://${encodeURIComponent(creds.username)}:${encodeURIComponent(creds.password)}@${host}`;
  const entries: ResolvedCarryEntry[] = [
    await contentEntry(tmpDir, 'git-credentials', `${line}\n`, '~/.git-credentials'),
  ];
  return {
    entries,
    items: [{ label: `${host} token (from your credential helper)`, dest: '~/.git-credentials' }],
  };
}

/** SSH plan: copy the identity key (+ signing key) — push over SSH, sign commits. */
async function planSshCreds(projectRoot: string, onLog: (l: string) => void): Promise<CredPlan> {
  const host = (await originHost(projectRoot)) ?? 'github.com';
  const entries: ResolvedCarryEntry[] = [];
  const items: CredPlanItem[] = [];

  const key = await resolveSshIdentity(host);
  if (key) {
    await pushKeyPair(key, entries, items, 'SSH key');
  } else {
    onLog(`with-credentials: no SSH identity found for ${host}`);
  }

  // Also copy an SSH signing key if commit signing uses one and it differs.
  const gpgsign = (await git(projectRoot, ['config', '--get', 'commit.gpgsign'])).toLowerCase();
  const format = (await git(projectRoot, ['config', '--get', 'gpg.format'])).toLowerCase();
  const signingKey = await git(projectRoot, ['config', '--get', 'user.signingkey']);
  if (gpgsign === 'true' && signingKey && format === 'ssh' && signingKey.includes('/')) {
    const path = signingKey.replace(/^~(?=\/)/, homedir());
    if (await fileExists(path)) await pushKeyPair(path, entries, items, 'SSH signing key');
  } else if (gpgsign === 'true' && format && format !== 'ssh') {
    onLog(
      `with-credentials: commit signing uses gpg.format=${format} — GPG signing keys are not copied (SSH signing only); in-box commits will be unsigned`,
    );
  }
  return { entries, items };
}

/** Render the chosen-mode summary + security warning. */
function printSummary(mode: 'token' | 'ssh', items: CredPlanItem[]): void {
  const destW = Math.max(4, ...items.map((i) => i.dest.length));
  const rows = [`  ${pad('dest', destW)}   what`];
  for (const i of items) rows.push(`  ${pad(i.dest, destW)}   ${i.label}`);
  log.message(rows.join('\n'));
  if (mode === 'ssh') {
    log.warn(
      'Copying your SSH PRIVATE KEY into the box. This is the riskiest option — the box user\n' +
        'has passwordless sudo (no boundary), and the key is captured in any snapshot/checkpoint.\n' +
        'Use a key dedicated to git, NOT the key you use to log into other servers.',
    );
  } else {
    log.warn(
      'Copying a GitHub token into the box so it can push with your PC off. Commits will be\n' +
        'UNSIGNED. The token lives in the box and in any snapshot/checkpoint of it.',
    );
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

/** Prompt for which credential to copy (TTY only). */
async function askMode(): Promise<'token' | 'ssh' | 'cancel'> {
  return select<'token' | 'ssh' | 'cancel'>({
    message: 'This box will push with your PC off — what credential should it hold?',
    options: [
      {
        value: 'token',
        label: 'GitHub token (recommended)',
        hint: 'push over HTTPS; commits unsigned; smallest exposure',
      },
      {
        value: 'ssh',
        label: 'SSH private key',
        hint: 'push over SSH + sign commits; DANGEROUS — use a dedicated key, not your server-login key',
      },
      { value: 'cancel', label: 'No — cancel', hint: "don't copy any credential" },
    ],
    initialValue: 'token',
  });
}

/**
 * Run the git-credentials gate for a `create`/launcher command in
 * `git.pushMode=direct`. Resolves the mode (asking on a TTY), builds the plan,
 * and returns the carry entries to merge into the box's carry payload.
 */
export async function runGitCredsGate(args: GitCredsGateArgs): Promise<GitCredsGateResult> {
  const onLog = args.onLog ?? (() => {});
  const tty = args.isTTY ?? process.stdin.isTTY;

  // Hard requirement: a human at a real terminal. Copying a credential into the
  // box has no non-interactive path by design — no flag value, no env, no `-y` —
  // so automation / CI / the `-i` queue can never do it without a person present.
  if (!tty) {
    throw new Error(
      'with-credentials: copying a credential into a box requires an interactive terminal — a ' +
        'human must choose token vs SSH key at the prompt. There is no non-interactive path ' +
        '(no flag value, env var, or -y). Run this command directly in your terminal.',
    );
  }

  const choice = await askMode();
  if (choice === 'cancel') return { decision: 'cancel' };
  const mode: GitCredsMode = choice;

  const plan = await buildCredsPlan(args.projectRoot, mode, onLog);
  if (plan.entries.length === 0) {
    log.warn(
      mode === 'token'
        ? 'with-credentials: no GitHub token found (credential helper + gh both empty). The box ' +
            'will not be able to push on its own. Run `gh auth login` or configure a git credential helper.'
        : 'with-credentials: no SSH key found. The box will not be able to push on its own.',
    );
    return { decision: 'skip', entries: [] };
  }

  printSummary(mode, plan.items);
  onLog(`with-credentials: mode=${mode}, copying ${String(plan.entries.length)} file(s) into the box`);
  return { decision: 'approve', entries: plan.entries };
}

/** Build the carry entries for a chosen mode (no prompt). Exposed for tests. */
export async function buildCredsPlan(
  projectRoot: string,
  mode: GitCredsMode,
  onLog: (l: string) => void = () => {},
): Promise<CredPlan> {
  return mode === 'token' ? planTokenCreds(projectRoot, onLog) : planSshCreds(projectRoot, onLog);
}

/**
 * Shared create-path helper: when `pushMode === 'direct'`, run the (interactive)
 * gate and return `existing` carry entries with the approved credential files
 * appended; on cancel, log + call `onClose` + exit(0); on hard error (incl. a
 * non-TTY), log + exit(1). When not in direct mode, returns `existing` untouched.
 */
export async function resolveGitCredsCarry(args: {
  pushMode: string;
  projectRoot: string;
  existing: ResolvedCarryEntry[];
  onLog?: (line: string) => void;
  onClose?: () => void;
}): Promise<ResolvedCarryEntry[]> {
  if (args.pushMode !== 'direct') return args.existing;
  try {
    const gate = await runGitCredsGate({
      projectRoot: args.projectRoot,
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
