/**
 * LLM accounts: several named logins / setup tokens / API keys per agent.
 *
 * Everything here is pure. The on-disk store (`~/.agentbox/accounts.json`, the
 * per-account secret files) lives in `@agentbox/sandbox-core`; this module owns
 * the shape, the id rule, and the ONE place each per-account name is derived —
 * secret file, custody path, docker volume, cloud volume subpath — so the
 * login, seed and fan-out phases cannot each invent their own spelling.
 *
 * `default` is today's single slot. Every derivation below maps `default` to the
 * name the one-slot model already uses, so an existing backup, custody object,
 * docker volume or Daytona subpath keeps its meaning with no migration step.
 * See docs/llm-accounts-plan.md.
 */

import { join } from 'node:path';
import type { AgentSyncSpec } from './agent-spec.js';

/**
 * How an account authenticates.
 *
 * - `login` — the agent's own OAuth/ChatGPT login file. Refreshes, so it rides
 *   the credential fan-out. A Claude refresh revokes every other holder's access
 *   token on the spot (measured, Phase 0), so a `login` shared by many boxes has
 *   an outage window per refresh.
 * - `setup-token` — a long-lived token (`claude setup-token`). Never refreshes,
 *   so it is the safe kind for an account many boxes share.
 * - `api-key` — a provider API key.
 */
export type LlmAccountKind = 'login' | 'setup-token' | 'api-key';

export const LLM_ACCOUNT_KINDS: readonly LlmAccountKind[] = ['login', 'setup-token', 'api-key'];

/** The slot every agent had before accounts existed. Always resolvable. */
export const DEFAULT_ACCOUNT_ID = 'default';

/** Read off the login for display. Never used to decide anything. */
export interface LlmAccountIdentity {
  email?: string;
  org?: string;
  plan?: string;
}

/** One account's metadata. Holds no secret. */
export interface LlmAccount {
  /** Registry id of the agent that owns the credential. */
  agent: string;
  /** `default` or a user-chosen slug — see {@link accountIdProblem}. */
  id: string;
  kind: LlmAccountKind;
  identity?: LlmAccountIdentity;
  /** ISO timestamp. For a migrated `default`, the legacy backup's mtime. */
  createdAt: string;
}

/** `~/.agentbox/accounts.json`. */
export interface AccountsFile {
  version: 1;
  accounts: LlmAccount[];
}

/**
 * Lowercase letters, digits and inner dashes, at most 32 chars.
 *
 * Narrow on purpose, because the id is spliced into names with their own
 * grammars: a docker volume name, a custody path segment, a file name, a
 * Daytona subpath. With no `.` or `/` it is always exactly one path segment
 * and can never traverse out of the directory it is joined under.
 */
const ACCOUNT_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;

/** What a NEW name may be: `_` separates words; `-` stays readable only on older ids. */
const NEW_ACCOUNT_NAME_RE = /^[a-z0-9](?:[a-z0-9_]{0,30}[a-z0-9])?$/;

/**
 * Agent ids are spliced into host paths (`credentials/<agent>/`), custody paths
 * and volume names too. Built-ins all fit; a plugin id is checked at `agent add`.
 */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Why `id` is not a path-safe agent id, or null when it is. */
export function agentIdProblem(id: string): string | null {
  if (!AGENT_ID_RE.test(id)) {
    return `agent id '${id}' must be 1-64 lowercase letters, digits, '-' or '_', starting with a letter or digit`;
  }
  return null;
}

/** Why `id` is not a usable account id, or null when it is. */
export function accountIdProblem(id: string): string | null {
  if (!ACCOUNT_ID_RE.test(id)) {
    return `account name '${id}' must be 1-32 lowercase letters, digits or '_'`;
  }
  return null;
}

/**
 * A typed name made into an account name: lowercased, runs of spaces or `-`
 * turned into `_` ("Work Max" -> `work_max`). Anything else that is not a
 * letter, digit or `_` is refused, not dropped, so the name the user sees is
 * the one stored.
 */
export function normalizeAccountName(
  input: string,
): { name: string; problem?: undefined } | { name?: undefined; problem: string } {
  const name = input
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!NEW_ACCOUNT_NAME_RE.test(name)) {
    return {
      problem: `'${input.trim()}' is not a usable name: use 1-32 letters, digits, spaces or '_' (got '${name}')`,
    };
  }
  return { name };
}

export function isDefaultAccount(id: string): boolean {
  return id === DEFAULT_ACCOUNT_ID;
}

/**
 * The account kinds `spec` supports. Empty means the agent has no named
 * accounts: it keeps its single `default` slot and nothing else.
 */
export function agentAccountKinds(spec: AgentSyncSpec): readonly LlmAccountKind[] {
  return spec.accountKinds ?? [];
}

/** Why `spec` cannot hold an account of `kind`, or null when it can. */
export function accountKindProblem(spec: AgentSyncSpec, kind: LlmAccountKind): string | null {
  const kinds = agentAccountKinds(spec);
  if (kinds.length === 0) return `agent '${spec.id}' does not support named accounts`;
  if (!kinds.includes(kind)) {
    return `agent '${spec.id}' does not support '${kind}' accounts (supported: ${kinds.join(', ')})`;
  }
  return null;
}

/**
 * Host file holding one account's secret.
 *
 * `default` keeps the legacy `~/.agentbox/<agent>-credentials.json`
 * (`credential.hostBackup`), so the backup every existing box was seeded from is
 * the `default` account's without a copy. Named accounts live under
 * `<stateDir>/credentials/<agent>/<account>.json`.
 *
 * Undefined when the account is `default` and the agent declares no credential:
 * there is no legacy slot to point at.
 */
export function accountSecretPath(
  spec: AgentSyncSpec,
  account: string,
  stateDir: string,
): string | undefined {
  if (isDefaultAccount(account)) return spec.credential?.hostBackup;
  // Both segments are joined into a host path: refuse rather than traverse.
  const problem = agentIdProblem(spec.id) ?? accountIdProblem(account);
  if (problem) throw new Error(problem);
  return join(stateDir, 'credentials', spec.id, `${account}.json`);
}

/**
 * The custody segment every named account nests under. Fixed rather than the
 * bare account id, because a plugin's credential file name need not contain a
 * `.`: with `agents/<agent>/<account>/<file>`, an account named after the file
 * would turn the `default` object into a directory. A plugin credential file
 * named exactly this is refused at `agent add`.
 */
export const ACCOUNTS_CUSTODY_SEGMENT = 'accounts';

/**
 * Custody-relative path of one account's credential file.
 *
 * `default` stays at `agents/<agent>/<file>`. A named account is keyed by the
 * MACHINE whose store holds it: `agents/<agent>/accounts/<machine>/<account>/<file>`.
 * Account ids are names local to each machine — two PCs' `claude/work` can be
 * two subscriptions — so the machine is part of the key (#442 review).
 */
export function accountCustodyPath(
  agent: string,
  account: string,
  file: string,
  machine?: string,
): string {
  if (isDefaultAccount(account)) return `agents/${agent}/${file}`;
  if (!machine || !/^[A-Za-z0-9._-]+$/.test(machine)) {
    throw new Error(`a named account's custody path needs the machine id it belongs to`);
  }
  return `agents/${agent}/${ACCOUNTS_CUSTODY_SEGMENT}/${machine}/${account}/${file}`;
}

/**
 * Joins a base docker volume / cloud subpath to a named account. `agent add`
 * refuses a base that already contains it, so one agent's account name can
 * never equal another agent's base or account name.
 */
export const ACCOUNT_NAME_INFIX = '-acct-';

/**
 * The per-account docker config volume.
 *
 * `default` is the shared volume boxes mount today. A named account gets
 * `<volume>-acct-<account>`, not `<volume>-<account>` as the plan first said:
 * `box.isolate<Agent>Config` already mints `<volume>-<boxId>`, and a box id
 * (`b` + 8 hex) is a valid account slug, so the bare form could hand one box's
 * isolated volume to an account.
 */
export function accountConfigVolume(baseVolume: string, account: string): string {
  return isDefaultAccount(account) ? baseVolume : `${baseVolume}${ACCOUNT_NAME_INFIX}${account}`;
}

/**
 * The docker volume an agent's session transcripts live in across ALL its
 * accounts (`agentbox-claude-config` -> `agentbox-claude-projects`), mounted
 * over the transcripts dir of the default and every named account volume so a
 * session can be resumed on another account. Never removed by `prune`.
 */
export function sharedProjectsVolume(baseVolume: string): string {
  return `${baseVolume.replace(/-config$/, '')}-projects`;
}

/**
 * Subpath of the shared cloud credentials volume (Daytona) for one account.
 * `default` keeps the agent's `credential.cloudSubpath` (`claude/`); a named
 * account gets a SIBLING, `claude-acct-work/`. Never a child: a default box
 * mounts the whole `claude/` subtree, so `claude/work/` would hand it every
 * named account's secret.
 */
export function accountCloudSubpath(baseSubpath: string, account: string): string {
  if (isDefaultAccount(account)) return baseSubpath;
  return `${baseSubpath.replace(/\/+$/, '')}${ACCOUNT_NAME_INFIX}${account}/`;
}

/** A legacy single-slot login found on the host, offered to the migration. */
export interface LegacyAccountSlot {
  agent: string;
  /** ISO timestamp, the backup file's mtime. */
  createdAt: string;
}

function parseIdentity(raw: unknown): LlmAccountIdentity | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: LlmAccountIdentity = {};
  for (const key of ['email', 'org', 'plan'] as const) {
    if (typeof r[key] === 'string' && r[key].length > 0) out[key] = r[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseAccount(raw: unknown): LlmAccount | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.agent !== 'string' || r.agent.length === 0) return null;
  if (typeof r.id !== 'string' || accountIdProblem(r.id) !== null) return null;
  if (typeof r.kind !== 'string' || !LLM_ACCOUNT_KINDS.includes(r.kind as LlmAccountKind)) {
    return null;
  }
  if (typeof r.createdAt !== 'string') return null;
  const account: LlmAccount = {
    agent: r.agent,
    id: r.id,
    kind: r.kind as LlmAccountKind,
    createdAt: r.createdAt,
  };
  const identity = parseIdentity(r.identity);
  if (identity) account.identity = identity;
  return account;
}

/**
 * Normalize a parsed `accounts.json` (or its absence) and fold in the legacy
 * single-slot logins.
 *
 * - Malformed rows, and rows `accept` refuses, are dropped from this VIEW
 *   rather than failing the read: one bad row must not hide every other
 *   account. A duplicate `(agent, id)` keeps the first. This is a read view
 *   only — the store never writes it back, so a row this process cannot
 *   validate (a newer kind, a plugin it has not loaded) survives on disk.
 * - `default` is listed iff its legacy login is real (`legacy` names it). A
 *   stored `default` row only contributes its metadata (its identity); a logout
 *   hides it, and a `default` with no row yet is synthesized as a `login` —
 *   the one-slot model only ever stored login files there.
 *
 * Pure and idempotent: feeding the output back in returns an equal value.
 */
export interface MigrateAccountsOptions {
  /** Keep a parsed row? The store passes the same rule writes go through. */
  accept?: (account: LlmAccount) => boolean;
  /**
   * Map an agent alias to its canonical id, applied BEFORE de-duplication so
   * `claude-code/work` and `claude/work` are one account.
   */
  canonicalAgent?: (agent: string) => string;
}

export function migrateAccountsFile(
  raw: unknown,
  legacy: readonly LegacyAccountSlot[],
  opts: MigrateAccountsOptions = {},
): AccountsFile {
  const accept = opts.accept ?? (() => true);
  const canonical = opts.canonicalAgent ?? ((a: string) => a);
  const rows =
    raw !== null && typeof raw === 'object' && Array.isArray((raw as AccountsFile).accounts)
      ? (raw as AccountsFile).accounts
      : [];
  const accounts: LlmAccount[] = [];
  const seen = new Set<string>();
  const key = (agent: string, id: string): string => `${agent}\u0000${id}`;
  const hasLegacy = new Set(legacy.map((l) => l.agent));
  for (const row of rows as unknown[]) {
    const parsed = parseAccount(row);
    const account = parsed ? { ...parsed, agent: canonical(parsed.agent) } : null;
    if (!account || seen.has(key(account.agent, account.id)) || !accept(account)) continue;
    if (isDefaultAccount(account.id) && !hasLegacy.has(account.agent)) continue;
    seen.add(key(account.agent, account.id));
    accounts.push(account);
  }
  for (const slot of legacy) {
    if (seen.has(key(slot.agent, DEFAULT_ACCOUNT_ID))) continue;
    seen.add(key(slot.agent, DEFAULT_ACCOUNT_ID));
    accounts.push({
      agent: slot.agent,
      id: DEFAULT_ACCOUNT_ID,
      kind: 'login',
      createdAt: slot.createdAt,
    });
  }
  return { version: 1, accounts };
}

/** The account `(agent, id)`, if the file has it. */
export function findAccount(file: AccountsFile, agent: string, id: string): LlmAccount | undefined {
  return file.accounts.find((a) => a.agent === agent && a.id === id);
}

/**
 * The NAMED entries of an agent→account map (`BoxRecord.accounts`), or
 * undefined when every agent is on `default`. The one place "named" is decided,
 * so seeding, the fan-out guard and propagate can never disagree about a box.
 */
export function namedAccounts(
  accounts: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [agent, id] of Object.entries(accounts ?? {})) {
    if (!isDefaultAccount(id)) out[agent] = id;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
