/**
 * The host's LLM account store: `~/.agentbox/accounts.json` (metadata) plus one
 * 0600 secret file per named account. The shape and every derived name live in
 * `@agentbox/core` (`llm-accounts.ts`); this module only does the I/O.
 *
 * Reads never write. The legacy single-slot logins (`<agent>-credentials.json`)
 * are folded in as account `default` on every read, so nothing has to run
 * before an existing install sees its accounts, and a hot read path (the hub's
 * listings) never takes the lock.
 *
 * Writes never round-trip the read VIEW. The view drops rows this process
 * cannot validate — a plugin agent added after a long-lived hub loaded its
 * registry, a kind a newer CLI knows — so writing it back would delete another
 * process's accounts. A mutation edits the file's own rows instead, replacing
 * or deleting only the `(agent, id)` it is about, and passes everything else
 * through verbatim. The legacy `default`s are added to the file on the first
 * mutation.
 *
 * Concurrency mirrors `state.ts`: an O_EXCL lockfile guards every
 * read-modify-write, and writes are atomic (temp + rename). `withFileLock`
 * proceeds UNLOCKED after waiting 20 s (shared behaviour, so a crashed holder
 * cannot wedge every CLI); the atomic rename keeps that to a possible lost
 * update, never a torn file.
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { allAgentSpecs } from '@agentbox/agent-registry';
import { withFileLock } from '@agentbox/config';
import {
  accountIdProblem,
  accountKindProblem,
  accountSecretPath,
  agentIdProblem,
  findAccount,
  isDefaultAccount,
  migrateAccountsFile,
  type AccountsFile,
  type AgentSyncSpec,
  type LegacyAccountSlot,
  type LlmAccount,
  type LlmAccountKind,
} from '@agentbox/core';
import { STATE_DIR } from './state.js';
import { isRealCredentialShape, shouldAcceptCredentialBlob } from './sync/concerns/credentials.js';

export const ACCOUNTS_FILE = join(STATE_DIR, 'accounts.json');

/** Where the store lives and which agents it knows. Tests point both elsewhere. */
export interface AccountStoreOptions {
  /** `accounts.json`. Defaults to {@link ACCOUNTS_FILE}. */
  path?: string;
  /** Root for named accounts' secrets (`<stateDir>/credentials/…`). Defaults to `~/.agentbox`. */
  stateDir?: string;
  /**
   * Registry rows. Defaults to the registry as it is NOW (`allAgentSpecs()`,
   * which re-reads `agents.json`), not the snapshot taken at module load: a
   * long-lived hub must see an agent added after it started.
   */
  specs?: readonly AgentSyncSpec[];
}

function resolveOpts(opts: AccountStoreOptions): Required<AccountStoreOptions> {
  return {
    path: opts.path ?? ACCOUNTS_FILE,
    stateDir: opts.stateDir ?? STATE_DIR,
    specs: opts.specs ?? allAgentSpecs(),
  };
}

/** By canonical id or alias, like `findAgentSpec`; the store keys rows by `spec.id`. */
function findSpec(specs: readonly AgentSyncSpec[], agent: string): AgentSyncSpec | undefined {
  return specs.find((s) => s.id === agent || s.aliases?.includes(agent));
}

function specFor(specs: readonly AgentSyncSpec[], agent: string): AgentSyncSpec {
  const spec = findSpec(specs, agent);
  if (!spec) throw new Error(`unknown agent '${agent}'`);
  const problem = agentIdProblem(spec.id);
  if (problem) throw new Error(problem);
  return spec;
}

function requireAccountId(id: string): void {
  const problem = accountIdProblem(id);
  if (problem) throw new Error(problem);
}

/** Thrown by a mutation when `accounts.json` exists but cannot be trusted. */
export class AccountsFileError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(
      `${path}: ${reason}. Refusing to rewrite it, which would drop every named account in it; ` +
        'fix or move the file and retry',
    );
    this.name = 'AccountsFileError';
  }
}

/**
 * The legacy single-slot logins on this host: every agent whose
 * `credential.hostBackup` holds a real credential (by that spec's own
 * `realShape`). A placeholder or garbage file is not a login.
 */
export async function findLegacyAccountSlots(
  specs: readonly AgentSyncSpec[] = allAgentSpecs(),
): Promise<LegacyAccountSlot[]> {
  const slots = await Promise.all(
    specs.map(async (spec): Promise<LegacyAccountSlot | null> => {
      const cred = spec.credential;
      if (!cred?.hostBackup) return null;
      try {
        const [text, st] = await Promise.all([
          readFile(cred.hostBackup, 'utf8'),
          stat(cred.hostBackup),
        ]);
        if (!isRealCredentialShape(cred.realShape, text)) return null;
        return { agent: spec.id, createdAt: st.mtime.toISOString() };
      } catch {
        return null; // absent or unreadable: no legacy login for this agent
      }
    }),
  );
  return slots.filter((s): s is LegacyAccountSlot => s !== null);
}

type RawRead = { ok: true; raw: unknown } | { ok: false; reason: string };

async function readRaw(path: string): Promise<RawRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, raw: undefined };
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  const f = raw as Partial<AccountsFile> | null;
  if (f === null || typeof f !== 'object' || Array.isArray(f) || !Array.isArray(f.accounts)) {
    return { ok: false, reason: 'not an accounts file (expected { version: 1, accounts: [...] })' };
  }
  if (f.version !== 1) return { ok: false, reason: `unsupported version ${String(f.version)}` };
  return { ok: true, raw };
}

function canonicalizer(specs: readonly AgentSyncSpec[]): (agent: string) => string {
  return (agent) => findSpec(specs, agent)?.id ?? agent;
}

function viewOf(
  raw: unknown,
  legacy: readonly LegacyAccountSlot[],
  specs: readonly AgentSyncSpec[],
): AccountsFile {
  return migrateAccountsFile(raw, legacy, {
    accept: (a) => accountProblem(a, specs) === null,
    canonicalAgent: canonicalizer(specs),
  });
}

/**
 * Every account on this host, with the legacy logins folded in as `default`.
 * Stored rows the write rules would refuse (unknown agent, unsupported kind, a
 * non-login `default`) are left out of this view, and so is an untrustworthy
 * file — the `default` logins still show, from their legacy files.
 */
export async function readAccounts(opts: AccountStoreOptions = {}): Promise<AccountsFile> {
  const o = resolveOpts(opts);
  const [read, legacy] = await Promise.all([readRaw(o.path), findLegacyAccountSlots(o.specs)]);
  return viewOf(read.ok ? read.raw : undefined, legacy, o.specs);
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp.${randomUUID()}`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

/**
 * A secret file, 0600 in a 0700 dir. `mkdir`'s mode only applies to a dir it
 * creates, so an existing `credentials/` or `credentials/<agent>/` with a looser
 * mode is tightened explicitly.
 */
async function writeSecretAtomic(path: string, content: string): Promise<void> {
  const agentDir = dirname(path);
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await chmod(dirname(agentDir), 0o700);
  await chmod(agentDir, 0o700);
  await writeAtomic(path, content);
}

function sameRow(
  row: unknown,
  agent: string,
  id: string,
  canonical: (a: string) => string,
): boolean {
  if (row === null || typeof row !== 'object') return false;
  const r = row as { agent?: unknown; id?: unknown };
  return typeof r.agent === 'string' && canonical(r.agent) === agent && r.id === id;
}

/**
 * Locked edit of the file's raw rows. `edit` sees the rows verbatim and returns
 * the rows to write. Legacy `default`s missing from the file are appended first,
 * which is how the migration reaches disk.
 */
async function editRows<T>(
  o: Required<AccountStoreOptions>,
  edit: (rows: unknown[]) => Promise<{ rows: unknown[]; result: T }>,
): Promise<T> {
  return withFileLock(o.path, async () => {
    const read = await readRaw(o.path);
    if (!read.ok) throw new AccountsFileError(o.path, read.reason);
    const legacy = await findLegacyAccountSlots(o.specs);
    const rows = read.raw === undefined ? [] : [...(read.raw as AccountsFile).accounts];
    const canonical = canonicalizer(o.specs);
    for (const slot of legacy) {
      if (!rows.some((r) => sameRow(r, slot.agent, 'default', canonical))) {
        rows.push({ agent: slot.agent, id: 'default', kind: 'login', createdAt: slot.createdAt });
      }
    }
    const { rows: next, result } = await edit(rows);
    await mkdir(dirname(o.path), { recursive: true });
    await writeAtomic(o.path, JSON.stringify({ version: 1, accounts: next }, null, 2) + '\n');
    return result;
  });
}

/** Why `account` cannot be stored, or null when it can. */
export function accountProblem(
  account: LlmAccount,
  specs: readonly AgentSyncSpec[] = allAgentSpecs(),
): string | null {
  const spec = findSpec(specs, account.agent);
  if (!spec) return `unknown agent '${account.agent}'`;
  const agentProblem = agentIdProblem(spec.id);
  if (agentProblem) return agentProblem;
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
 * hold. Writes no secret — add the row first, then {@link writeAccountSecret}.
 * Returns the stored row (agent canonicalized).
 */
export async function upsertAccount(
  account: LlmAccount,
  opts: AccountStoreOptions = {},
): Promise<LlmAccount> {
  const o = resolveOpts(opts);
  const problem = accountProblem(account, o.specs);
  if (problem) throw new Error(problem);
  const row: LlmAccount = { ...account, agent: specFor(o.specs, account.agent).id };
  const canonical = canonicalizer(o.specs);
  return editRows(o, (rows) =>
    Promise.resolve({
      rows: [...rows.filter((r) => !sameRow(r, row.agent, row.id, canonical)), row],
      result: row,
    }),
  );
}

/**
 * Remove a named account: its row and its secret file, under one lock so a
 * concurrent re-create cannot lose its fresh secret. Returns false when there
 * was no such row. `default` is refused — it is the legacy login every existing
 * box was seeded from, and deleting it is a logout, not an account removal.
 */
export async function removeAccount(
  agent: string,
  id: string,
  opts: AccountStoreOptions = {},
): Promise<boolean> {
  const o = resolveOpts(opts);
  if (isDefaultAccount(id)) throw new Error('the default account cannot be removed');
  requireAccountId(id);
  const spec = specFor(o.specs, agent);
  const secret = accountSecretPath(spec, id, o.stateDir);
  const canonical = canonicalizer(o.specs);
  return editRows(o, async (rows) => {
    const next = rows.filter((r) => !sameRow(r, spec.id, id, canonical));
    if (secret) await rm(secret, { force: true });
    return { rows: next, result: next.length !== rows.length };
  });
}

/**
 * Run `fn` under the accounts lock (the one every store mutation takes). For a
 * writer outside this module — the relay's fan-out, the custody seed — whose
 * row check and secret write must be one step, so an `accounts rm` cannot land
 * between them and leave a secret with no row. Not re-entrant: `fn` must not
 * call a store mutation.
 */
export function withAccountsLock<T>(
  fn: () => Promise<T>,
  opts: Pick<AccountStoreOptions, 'path'> = {},
): Promise<T> {
  return withFileLock(opts.path ?? ACCOUNTS_FILE, fn);
}

/** Decides whether `incoming` may replace `existing` (null when there is none). */
export type AccountSecretGate = (
  incoming: string,
  existing: string | null,
) => { accept: boolean; reason: string };

export interface WriteAccountSecretResult {
  path: string;
  written: boolean;
  reason: string;
}

/**
 * Write a NAMED account's secret, 0600 in a 0700 dir, after checking it is the
 * account's kind of secret:
 *
 * - `login`: a real credential by the agent's `realShape`, and newer than what
 *   is on disk by the agent's freshness rule (`written: false` otherwise). A
 *   rotating login that accepts an older blob is dead for every other holder
 *   (Phase 0), so this is the same gate the credential fan-out applies.
 * - `setup-token` / `api-key`: an {@link encodePastedSecret} of that kind.
 *
 * The account's row must exist (add it first). `default` is refused: it is the
 * legacy backup, written only by the existing guarded paths
 * (`writeCredentialBackup` behind `shouldAcceptCredentialUpdate`).
 */
export async function writeAccountSecret(
  agent: string,
  id: string,
  content: string,
  opts: AccountStoreOptions & {
    /** A login's freshness gate. Default: the agent's `freshness` rule. */
    gate?: AccountSecretGate;
  } = {},
): Promise<WriteAccountSecretResult> {
  const o = resolveOpts(opts);
  if (isDefaultAccount(id)) {
    throw new Error(
      "the default account's secret is the legacy credential backup; write it through writeCredentialBackup",
    );
  }
  requireAccountId(id);
  const spec = specFor(o.specs, agent);
  const path = accountSecretPath(spec, id, o.stateDir)!;
  // Under the accounts lock: the row check and the write are one step, and a
  // concurrent removeAccount of this id cannot delete the secret after it.
  return withFileLock(o.path, async () => {
    const account = findAccount(await readAccounts(o), spec.id, id);
    if (!account) throw new Error(`no account '${id}' for agent '${spec.id}'; add it first`);
    if (account.kind === 'login') {
      if (!isRealCredentialShape(spec.credential?.realShape, content)) {
        throw new Error(`not a usable '${spec.id}' login credential`);
      }
      const existing = await readFile(path, 'utf8').catch(() => null);
      const gate = opts.gate
        ? opts.gate(content, existing)
        : shouldAcceptCredentialBlob(spec.credential?.freshness?.jsonPath, content, existing);
      if (!gate.accept) return { path, written: false, reason: gate.reason };
      await writeSecretAtomic(path, content);
      return { path, written: true, reason: gate.reason };
    }
    if (decodePastedSecret(content)?.kind !== account.kind) {
      throw new Error(`a '${account.kind}' account's secret must be an encoded ${account.kind}`);
    }
    await writeSecretAtomic(path, content);
    return { path, written: true, reason: 'pasted secret' };
  });
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

/** What `<agent> login` was asked to sign in, from its account flags. */
export interface LoginAccountRequest {
  /** A named account id; never `default` (that is the plain login). */
  id: string;
  kind: LlmAccountKind;
}

/**
 * Resolve `<agent> login`'s account flags. `null` means the plain login into
 * the `default` slot, exactly as before accounts existed. Throws a message for
 * the user on a combination that cannot work.
 *
 * A pasted kind needs a NAMED account: `default` is the legacy login file
 * (see {@link accountProblem}).
 */
export function resolveLoginAccount(
  spec: AgentSyncSpec,
  opts: { account?: string; apiKey?: boolean; setupToken?: boolean },
): LoginAccountRequest | null {
  if (opts.apiKey && opts.setupToken) {
    throw new Error('choose one of --api-key and --setup-token');
  }
  const kind: LlmAccountKind = opts.apiKey ? 'api-key' : opts.setupToken ? 'setup-token' : 'login';
  const id = opts.account?.trim();
  if (id === undefined || id === '' || isDefaultAccount(id)) {
    if (kind !== 'login') {
      throw new Error(
        `${kind === 'api-key' ? 'an API key' : 'a setup token'} needs a named account: add --account <name> (the default account is the agent's login)`,
      );
    }
    return null;
  }
  requireAccountId(id);
  const kindProblem = accountKindProblem(spec, kind);
  if (kindProblem) throw new Error(kindProblem);
  return { id, kind };
}

/**
 * Light sanity check on a pasted secret, so a stray newline or a pasted
 * sentence fails here rather than as an auth error inside a box. Deliberately
 * NOT a prefix check: Anthropic issues more key shapes than one prefix covers
 * (Phase 0 met an `sk-ant-usr` key).
 */
export function pastedSecretProblem(token: string): string | null {
  if (token.length === 0) return 'the secret is empty';
  if (/\s/.test(token)) return 'the secret contains whitespace; paste the token alone';
  if (token.length < 16) return 'the secret is too short to be a token';
  return null;
}
