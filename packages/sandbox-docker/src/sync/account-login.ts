/**
 * Capture a NAMED account's login from its docker config volume into the host
 * account store (docs/llm-accounts-plan.md, Phase 2).
 *
 * A named login signs in against its own volume (`accountConfigVolume`), never
 * the shared one, and is captured here into `credentials/<agent>/<id>.json` —
 * never into the legacy `<agent>-credentials.json`, which is `default`'s. The
 * write goes through `writeAccountSecret`, so it is shape-checked and
 * newest-wins gated like every other credential write.
 */
import { execa } from 'execa';
import {
  findAccount,
  type AgentSyncSpec,
  type LlmAccount,
  type LlmAccountIdentity,
} from '@agentbox/core';
import {
  readAccounts,
  credentialIdentityMatch,
  readAccountsChecked,
  readAccountSecret,
  removeAccount,
  upsertAccount,
  writeAccountSecret,
  type AccountStoreOptions,
} from '@agentbox/sandbox-core';

/**
 * Volume-relative paths → each one's contents, or null when the file is
 * absent. Throws when the volume cannot be read at all (docker failed), which
 * is not the same as "the login left no file".
 */
export type VolumeFileReader = (rels: readonly string[]) => Promise<Record<string, string | null>>;

function relPathProblem(rel: string): string | null {
  if (rel.length === 0 || rel.startsWith('/')) return 'must be a relative path';
  if (/[\t\n\r]/.test(rel)) return 'must not contain tabs or newlines';
  if (rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return 'must not contain empty, `.` or `..` segments';
  }
  return null;
}

/**
 * One line per requested file: `<rel>\t<base64>` when it is a regular file,
 * `<rel>\t-` when it is not. base64 so any byte survives the line protocol.
 */
const READ_FILES_SCRIPT =
  'for f in "$@"; do if [ -f "/dst/$f" ]; then printf \'%s\\t\' "$f"; base64 -w0 "/dst/$f" || exit 3; printf \'\\n\'; ' +
  'else printf \'%s\\t-\\n\' "$f"; fi; done';

/** Parse {@link READ_FILES_SCRIPT}'s output. Pure. */
export function parseVolumeFiles(
  stdout: string,
  rels: readonly string[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const rel = line.slice(0, tab);
    const body = line.slice(tab + 1);
    if (!rels.includes(rel)) continue;
    out[rel] = body === '-' ? null : Buffer.from(body, 'base64').toString('utf8');
  }
  for (const rel of rels) {
    if (!(rel in out)) throw new Error(`the volume read returned nothing for '${rel}'`);
  }
  return out;
}

/**
 * Read files out of a docker volume, as text, in ONE throwaway container. The
 * contents stay in this process — callers must never log them.
 */
export async function readDockerVolumeFiles(
  volume: string,
  image: string,
  rels: readonly string[],
): Promise<Record<string, string | null>> {
  for (const rel of rels) {
    const problem = relPathProblem(rel);
    if (problem) throw new Error(`volume path '${rel}' ${problem}`);
  }
  if (rels.length === 0) return {};
  const res = await execa(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${volume}:/dst:ro`,
      image,
      'sh',
      '-c',
      READ_FILES_SCRIPT,
      'sh',
      ...rels,
    ],
    { reject: false },
  );
  if (res.exitCode !== 0) {
    const why = String(res.stderr ?? '').trim() || `exit ${String(res.exitCode)}`;
    throw new Error(`could not read the docker volume ${volume}: ${why.slice(-300)}`);
  }
  return parseVolumeFiles(String(res.stdout ?? ''), rels);
}

/** A {@link VolumeFileReader} over one docker volume. */
export function dockerVolumeFileReader(volume: string, image: string): VolumeFileReader {
  return (rels) => readDockerVolumeFiles(volume, image, rels);
}

/**
 * The identity to store after a re-login: the new one, with the stored email
 * and org kept where the new one lacks them. A re-login whose warm-up turn
 * failed reads a plan-only identity (the reset removed `oauthAccount`), which
 * must not wipe the label. Only for the SAME login: `sameLogin` is what the
 * two credentials' identity fields say (false: another subscription signed in
 * under this name, so its identity is taken as it is; undefined: they cannot
 * tell, so only two known, different plans count as another one). Display
 * only. Pure.
 */
export function mergeAccountIdentity(
  stored: LlmAccountIdentity | undefined,
  fresh: LlmAccountIdentity | undefined,
  sameLogin?: boolean,
): LlmAccountIdentity | undefined {
  if (!fresh) return sameLogin === false ? undefined : stored;
  if (!stored) return fresh;
  if (sameLogin === false) return fresh;
  // Cannot tell from the credentials: only two KNOWN, different plans say it
  // is another subscription; a missing plan keeps the label.
  if (sameLogin === undefined && fresh.plan && stored.plan && fresh.plan !== stored.plan) {
    return fresh;
  }
  const out: LlmAccountIdentity = { ...fresh };
  if (!out.email && stored.email) out.email = stored.email;
  if (!out.org && stored.org) out.org = stored.org;
  return out;
}

/**
 * Remove a named account's config volume when the store has no row for the
 * account: a first login that failed or was cancelled leaves one behind, and
 * `credentials rm` cannot remove it (no row). Never touches a volume of an
 * account that exists, so a failed RE-login keeps its account's live volume.
 * Best-effort; returns whether a volume was removed.
 */
export async function dropOrphanAccountVolume(
  agent: string,
  id: string,
  volume: string,
  store?: AccountStoreOptions,
  removeVolume: (volume: string) => Promise<{ exitCode?: number; stderr?: unknown }> = (v) =>
    execa('docker', ['volume', 'rm', v], { reject: false }),
): Promise<boolean> {
  try {
    // A store that cannot be trusted (corrupt, unsupported version) reads as
    // no named rows, which would make a live account's volume look orphaned.
    const { file, problem } = await readAccountsChecked(store);
    if (problem || findAccount(file, agent, id)) return false;
  } catch {
    return false; // cannot tell: keep it
  }
  // The aborted login container may still be going away and hold the volume
  // for a moment: retry "in use" for a few seconds.
  for (let attempt = 0; ; attempt++) {
    const r = await removeVolume(volume);
    if (r.exitCode === 0) return true;
    if (!/in use/i.test(String(r.stderr ?? '')) || attempt >= 10) return false;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** How an agent reads a display identity off a captured login. */
export interface AccountIdentityReader {
  /** Volume-relative files `parse` needs (the credential file included, if wanted). */
  files: readonly string[];
  parse(files: Readonly<Record<string, string | null>>): LlmAccountIdentity | undefined;
}

export interface CaptureVolumeLoginOptions {
  spec: AgentSyncSpec;
  account: { id: string };
  read: VolumeFileReader;
  identity?: AccountIdentityReader;
  store?: AccountStoreOptions;
  now?: () => Date;
}

export interface CaptureVolumeLoginResult {
  written: boolean;
  reason: string;
  identity?: LlmAccountIdentity;
}

/**
 * Store the login the volume now holds as account `account.id`.
 *
 * The row is written first (the store requires it), then the secret. A brand
 * new account whose secret is refused is removed again, so a failed login
 * leaves nothing behind; a re-login of an existing account keeps its row.
 */
export async function captureVolumeLogin(
  o: CaptureVolumeLoginOptions,
): Promise<CaptureVolumeLoginResult> {
  const cred = o.spec.credential;
  if (!cred) throw new Error(`agent '${o.spec.id}' declares no credential to capture`);
  const rels = [...new Set([cred.boxRelPath, ...(o.identity?.files ?? [])])];
  const files = await o.read(rels);
  const text = files[cred.boxRelPath] ?? null;
  if (text === null || text.trim() === '') {
    throw new Error(`the login did not leave a credential in the account's volume`);
  }
  const identity = o.identity ? o.identity.parse(files) : undefined;
  const existing = findAccount(await readAccounts(o.store), o.spec.id, o.account.id);
  if (existing && existing.kind !== 'login') {
    throw new Error(
      `account '${o.account.id}' is a ${existing.kind} account; remove it first to sign in a login under that name`,
    );
  }
  const row: LlmAccount = {
    agent: o.spec.id,
    id: o.account.id,
    kind: 'login',
    createdAt: existing?.createdAt ?? (o.now ?? (() => new Date()))().toISOString(),
  };
  // The row must exist before its secret, but it must not describe a login the
  // store then refuses: an existing account keeps its old identity until the
  // new secret is actually written.
  // Whether the stored login and the new one are one subscription, by the
  // agent's declared identity fields (account / org uuid).
  const storedSecret = existing
    ? await readAccountSecret(o.spec.id, o.account.id, o.store).catch(() => null)
    : null;
  const sameLogin =
    storedSecret === null ? undefined : credentialIdentityMatch(o.spec, text, storedSecret);
  const newIdentity = mergeAccountIdentity(existing?.identity, identity, sameLogin);
  const before = existing ? existing.identity : newIdentity;
  if (before) row.identity = before;
  await upsertAccount(row, o.store);
  let res: { written: boolean; reason: string };
  try {
    res = await writeAccountSecret(o.spec.id, o.account.id, text, o.store);
  } catch (err) {
    if (!existing) await removeAccount(o.spec.id, o.account.id, o.store).catch(() => {});
    throw err;
  }
  if (!res.written) return { written: false, reason: res.reason, identity: before };
  if (existing && newIdentity !== before) {
    // Built from the row WITHOUT the old identity: another subscription
    // signed in under this name and read none must show none, not the old one.
    const { identity: _old, ...rest } = row;
    void _old;
    await upsertAccount({ ...rest, ...(newIdentity ? { identity: newIdentity } : {}) }, o.store);
  }
  return { written: true, reason: res.reason, identity: newIdentity };
}
