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
  label?: string;
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
 * Daytona subpath. It contains no `.`, which is what keeps the custody layout
 * unambiguous: `agents/codex/auth.json` (the `default` file) can never be read
 * as an account directory named `auth.json`.
 */
const ACCOUNT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Why `id` is not a usable account id, or null when it is. */
export function accountIdProblem(id: string): string | null {
  if (!ACCOUNT_ID_RE.test(id)) {
    return `account name '${id}' must be 1-32 lowercase letters, digits or inner dashes`;
  }
  return null;
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
  return join(stateDir, 'credentials', spec.id, `${account}.json`);
}

/**
 * Custody-relative path of one account's credential file.
 * `default` stays at `agents/<agent>/<file>`; a named account is one level
 * deeper, `agents/<agent>/<account>/<file>`.
 */
export function accountCustodyPath(agent: string, account: string, file: string): string {
  return isDefaultAccount(account)
    ? `agents/${agent}/${file}`
    : `agents/${agent}/${account}/${file}`;
}

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
  return isDefaultAccount(account) ? baseVolume : `${baseVolume}-acct-${account}`;
}

/**
 * Subpath of the shared cloud credentials volume (Daytona) for one account.
 * `default` keeps the agent's `credential.cloudSubpath` (`claude/`); a named
 * account nests under it (`claude/work/`).
 */
export function accountCloudSubpath(baseSubpath: string, account: string): string {
  if (isDefaultAccount(account)) return baseSubpath;
  const base = baseSubpath.endsWith('/') ? baseSubpath : `${baseSubpath}/`;
  return `${base}${account}/`;
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
  if (typeof r.label === 'string' && r.label.length > 0) account.label = r.label;
  const identity = parseIdentity(r.identity);
  if (identity) account.identity = identity;
  return account;
}

/**
 * Normalize a parsed `accounts.json` (or its absence) and fold in the legacy
 * single-slot logins.
 *
 * - Malformed rows are dropped rather than failing the read: one bad row must
 *   not hide every other account. A duplicate `(agent, id)` keeps the first.
 * - Every legacy slot with no `default` row becomes `default`, kind `login` —
 *   the one-slot model only ever stored login files there. An existing
 *   `default` row wins, so a label the user gave it survives.
 *
 * Pure and idempotent: feeding the output back in returns an equal value.
 */
export function migrateAccountsFile(
  raw: unknown,
  legacy: readonly LegacyAccountSlot[],
): AccountsFile {
  const rows =
    raw !== null && typeof raw === 'object' && Array.isArray((raw as AccountsFile).accounts)
      ? (raw as AccountsFile).accounts
      : [];
  const accounts: LlmAccount[] = [];
  const seen = new Set<string>();
  const key = (agent: string, id: string): string => `${agent}\u0000${id}`;
  for (const row of rows as unknown[]) {
    const account = parseAccount(row);
    if (!account || seen.has(key(account.agent, account.id))) continue;
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
