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
  removeAccount,
  upsertAccount,
  writeAccountSecret,
  type AccountStoreOptions,
} from '@agentbox/sandbox-core';

/** Volume-relative path → contents, or null when the file is absent. */
export type VolumeFileReader = (rel: string) => Promise<string | null>;

function relPathProblem(rel: string): string | null {
  if (rel.length === 0 || rel.startsWith('/')) return 'must be a relative path';
  if (rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return 'must not contain empty, `.` or `..` segments';
  }
  return null;
}

/**
 * Read one file out of a docker volume, as text, in a throwaway container.
 * The contents stay in this process — callers must never log them.
 */
export function dockerVolumeFileReader(volume: string, image: string): VolumeFileReader {
  return async (rel) => {
    const problem = relPathProblem(rel);
    if (problem) throw new Error(`volume path '${rel}' ${problem}`);
    const res = await execa(
      'docker',
      ['run', '--rm', '--user', '0', '-v', `${volume}:/dst:ro`, image, 'cat', `/dst/${rel}`],
      { reject: false, stripFinalNewline: false },
    );
    return res.exitCode === 0 ? res.stdout : null;
  };
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
  const text = await o.read(cred.boxRelPath);
  if (text === null || text.trim() === '') {
    throw new Error(`the login did not leave a credential in the account's volume`);
  }
  let identity: LlmAccountIdentity | undefined;
  if (o.identity) {
    const files: Record<string, string | null> = {};
    for (const rel of o.identity.files) {
      files[rel] = rel === cred.boxRelPath ? text : await o.read(rel);
    }
    identity = o.identity.parse(files);
  }
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
  const newIdentity = identity ?? existing?.identity;
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
    await upsertAccount({ ...row, ...(newIdentity ? { identity: newIdentity } : {}) }, o.store);
  }
  return { written: true, reason: res.reason, identity: newIdentity };
}
