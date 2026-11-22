/**
 * The host's LLM account store: `~/.agentbox/accounts.json` (metadata) plus one
 * 0600 secret file per named account. The shape and every derived name live in
 * `@agentbox/core` (`llm-accounts.ts`); this module only does the I/O.
 *
 * Reads never write. The legacy single-slot logins (`<agent>-credentials.json`)
 * are folded in as account `default` on every read, so nothing has to run
 * before an existing install sees its accounts, and a hot read path (the hub's
 * listings) never takes the lock. The migrated rows reach disk on the first
 * mutation, which goes through the same fold.
 *
 * Concurrency + durability mirror `state.ts`: an O_EXCL lockfile guards the
 * read-modify-write and writes are atomic (temp + rename).
 */

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withFileLock } from '@agentbox/config';
import {
  accountIdProblem,
  accountKindProblem,
  accountSecretPath,
  isDefaultAccount,
  migrateAccountsFile,
  type AccountsFile,
  type AgentSyncSpec,
  type LegacyAccountSlot,
  type LlmAccount,
  type LlmAccountKind,
} from '@agentbox/core';
import { AGENT_SYNC_SPECS } from './sync/registry.js';
import { STATE_DIR } from './state.js';
import { isRealAgentCredential } from './sync/concerns/credentials.js';

export const ACCOUNTS_FILE = join(STATE_DIR, 'accounts.json');

/** Where the store lives and which agents it knows. Tests point both elsewhere. */
export interface AccountStoreOptions {
  /** `accounts.json`. Defaults to {@link ACCOUNTS_FILE}. */
  path?: string;
  /** Root for named accounts' secrets (`<stateDir>/credentials/…`). Defaults to `~/.agentbox`. */
  stateDir?: string;
  /** Registry rows. Defaults to every registered agent. */
  specs?: readonly AgentSyncSpec[];
}

function resolveOpts(opts: AccountStoreOptions): Required<AccountStoreOptions> {
  return {
    path: opts.path ?? ACCOUNTS_FILE,
    stateDir: opts.stateDir ?? STATE_DIR,
    specs: opts.specs ?? AGENT_SYNC_SPECS,
  };
}

function specFor(specs: readonly AgentSyncSpec[], agent: string): AgentSyncSpec {
  const spec = specs.find((s) => s.id === agent);
  if (!spec) throw new Error(`unknown agent '${agent}'`);
  return spec;
}

/**
 * The legacy single-slot logins on this host: every agent whose
 * `credential.hostBackup` holds a real credential. A placeholder or garbage
 * file is not a login, so it does not become an account.
 */
export async function findLegacyAccountSlots(
  specs: readonly AgentSyncSpec[] = AGENT_SYNC_SPECS,
): Promise<LegacyAccountSlot[]> {
  const out: LegacyAccountSlot[] = [];
  for (const spec of specs) {
    const path = spec.credential?.hostBackup;
    if (!path) continue;
    try {
      const [text, st] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      if (!isRealAgentCredential(spec.id, text)) continue;
      out.push({ agent: spec.id, createdAt: st.mtime.toISOString() });
    } catch {
      // absent or unreadable: no legacy login for this agent
    }
  }
  return out;
}

async function readRaw(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // A corrupt index must not hide the default logins, which are still on
    // disk in their legacy files. Read it as empty; the next mutation rewrites it.
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

/** Every account on this host, with the legacy logins folded in as `default`. */
export async function readAccounts(opts: AccountStoreOptions = {}): Promise<AccountsFile> {
  const o = resolveOpts(opts);
  const [raw, legacy] = await Promise.all([readRaw(o.path), findLegacyAccountSlots(o.specs)]);
  return migrateAccountsFile(raw, legacy);
}

async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${String(process.pid)}.${String(Date.now())}`;
  await writeFile(tmp, content, { mode });
  await rename(tmp, path);
  await chmod(path, mode).catch(() => {});
}

/**
 * Locked read-modify-write of `accounts.json`. `mutator` sees the migrated
 * file, so the first mutation on an existing install also persists `default`.
 */
export async function mutateAccounts(
  mutator: (file: AccountsFile) => AccountsFile,
  opts: AccountStoreOptions = {},
): Promise<AccountsFile> {
  const o = resolveOpts(opts);
  return withFileLock(o.path, async () => {
    const next = mutator(await readAccounts(o));
    await writeAtomic(o.path, JSON.stringify(next, null, 2) + '\n', 0o600);
    return next;
  });
}

/** Why `account` cannot be stored, or null when it can. */
export function accountProblem(
  account: LlmAccount,
  specs: readonly AgentSyncSpec[] = AGENT_SYNC_SPECS,
): string | null {
  const spec = specs.find((s) => s.id === account.agent);
  if (!spec) return `unknown agent '${account.agent}'`;
  const idProblem = accountIdProblem(account.id);
  if (idProblem) return idProblem;
  // `default` IS the legacy login file. Any other kind would need a different
  // secret path for the same id, and today's boxes read that file as a login.
  if (isDefaultAccount(account.id)) {
    if (!spec.credential)
      return `agent '${spec.id}' declares no credential, so it has no default account`;
    return account.kind === 'login'
      ? null
      : `the default account is the agent's login; use a named account for a '${account.kind}'`;
  }
  return accountKindProblem(spec, account.kind);
}

/**
 * Insert or replace one account's metadata. Refuses an account the agent cannot
 * hold. Writes no secret: that is the login / paste step's job.
 */
export async function upsertAccount(
  account: LlmAccount,
  opts: AccountStoreOptions = {},
): Promise<AccountsFile> {
  const o = resolveOpts(opts);
  const problem = accountProblem(account, o.specs);
  if (problem) throw new Error(problem);
  return mutateAccounts(
    (file) => ({
      version: 1,
      accounts: [
        ...file.accounts.filter((a) => !(a.agent === account.agent && a.id === account.id)),
        account,
      ],
    }),
    o,
  );
}

/**
 * Remove a named account: its row and its secret file. Returns false when there
 * was no such account. `default` is refused — it is the legacy login every
 * existing box was seeded from, and deleting it is a logout, not an account
 * removal.
 */
export async function removeAccount(
  agent: string,
  id: string,
  opts: AccountStoreOptions = {},
): Promise<boolean> {
  const o = resolveOpts(opts);
  if (isDefaultAccount(id)) throw new Error('the default account cannot be removed');
  const spec = specFor(o.specs, agent);
  let found = false;
  await mutateAccounts((file) => {
    const accounts = file.accounts.filter((a) => !(a.agent === agent && a.id === id));
    found = accounts.length !== file.accounts.length;
    return { version: 1, accounts };
  }, o);
  const secret = accountSecretPath(spec, id, o.stateDir);
  if (secret) await rm(secret, { force: true });
  return found;
}

/**
 * Write one account's secret, 0600 in a 0700 dir. For a `login` it is the
 * agent's own credential file; for a pasted kind, {@link encodePastedSecret}.
 */
export async function writeAccountSecret(
  agent: string,
  id: string,
  content: string,
  opts: AccountStoreOptions = {},
): Promise<string> {
  const o = resolveOpts(opts);
  const idProblem = accountIdProblem(id);
  if (idProblem) throw new Error(idProblem);
  const path = accountSecretPath(specFor(o.specs, agent), id, o.stateDir);
  if (!path)
    throw new Error(`agent '${agent}' declares no credential, so it has no default account`);
  await writeAtomic(path, content, 0o600);
  return path;
}

/** One account's secret, or null when it has none on disk. */
export async function readAccountSecret(
  agent: string,
  id: string,
  opts: AccountStoreOptions = {},
): Promise<string | null> {
  const o = resolveOpts(opts);
  if (accountIdProblem(id)) return null;
  const path = accountSecretPath(specFor(o.specs, agent), id, o.stateDir);
  if (!path) return null;
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** The secret file of a `setup-token` or `api-key` account. */
export interface PastedAccountSecret {
  kind: Exclude<LlmAccountKind, 'login'>;
  token: string;
}

export function encodePastedSecret(secret: PastedAccountSecret): string {
  return JSON.stringify(secret) + '\n';
}

/** The pasted secret in `text`, or null when it is not one (a login blob, garbage). */
export function decodePastedSecret(text: string): PastedAccountSecret | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (
      (parsed.kind === 'setup-token' || parsed.kind === 'api-key') &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0
    ) {
      return { kind: parsed.kind, token: parsed.token };
    }
  } catch {
    // not JSON
  }
  return null;
}
