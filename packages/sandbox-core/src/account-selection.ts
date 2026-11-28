/**
 * Which LLM account a box runs on, and what that means for its env
 * (docs/llm-accounts-plan.md, Phase 3).
 *
 * Resolution is `--account` > project config > global config > `default`.
 * The repo's `agentbox.yaml` `defaults:` layer is deliberately NOT read: an
 * account name is a per-user fact, and a repo must not be able to choose which
 * of your subscriptions it bills.
 */
import type { LoadedConfig } from '@agentbox/config';
import {
  agentAccountKinds,
  accountIdProblem,
  DEFAULT_ACCOUNT_ID,
  findAccount,
  isDefaultAccount,
  type AgentSyncSpec,
  type BoxRecord,
} from '@agentbox/core';
import {
  decodePastedSecret,
  readAccounts,
  readAccountSecret,
  type AccountStoreOptions,
} from './llm-accounts.js';
import { findAgentSpec } from './sync/registry.js';

const SETTING = 'account';

function layerValue(values: unknown, agent: string): string | undefined {
  const block = (values as Record<string, unknown> | undefined)?.[agent];
  const v = (block as Record<string, unknown> | undefined)?.[SETTING];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * Parse `--account` values. On `agentbox <agent>` a bare `work` means that
 * agent; on `agentbox create` (no agent) each value must be `<agent>=<name>`.
 * Throws a message for the user.
 */
export function parseAccountFlags(
  values: readonly string[] | undefined,
  defaultAgent?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of values ?? []) {
    for (const part of raw.split(',')) {
      const v = part.trim();
      if (!v) continue;
      const eq = v.indexOf('=');
      let agent: string;
      let id: string;
      if (eq === -1) {
        if (!defaultAgent) throw new Error(`--account needs <agent>=<name> here (got '${v}')`);
        agent = defaultAgent;
        id = v;
      } else {
        const named = findAgentSpec(v.slice(0, eq).trim());
        if (!named) throw new Error(`--account: unknown agent '${v.slice(0, eq)}'`);
        agent = named.id;
        id = v.slice(eq + 1).trim();
      }
      const problem = accountIdProblem(id);
      if (problem) throw new Error(`--account: ${problem}`);
      if (out[agent] !== undefined && out[agent] !== id) {
        throw new Error(`--account: two accounts for ${agent} ('${out[agent]}', '${id}')`);
      }
      out[agent] = id;
    }
  }
  return out;
}

/** Where a new box's account for one agent comes from. */
export interface AccountDefault {
  /** The account a new box gets (`default` = the agent's own login). */
  account: string;
  source: 'project' | 'global' | 'default';
  /** `<agent>.account` in the project config layer, when set. */
  project?: string;
  /** `<agent>.account` in the global config layer, when set. */
  global?: string;
}

/**
 * The account a new box would get per agent, with no `--account` flag: the
 * project setting, else the global one, else the default login (the same order
 * {@link resolveBoxAccounts} applies). The repo's agentbox.yaml never counts.
 * Pure.
 */
export function accountDefaults(
  agents: readonly string[],
  config: Pick<LoadedConfig, 'layers'> | undefined,
): Record<string, AccountDefault> {
  const out: Record<string, AccountDefault> = {};
  for (const agent of agents) {
    const project = layerValue(config?.layers.project.values, agent);
    const global = layerValue(config?.layers.global.values, agent);
    out[agent] = {
      account: project ?? global ?? DEFAULT_ACCOUNT_ID,
      source: project ? 'project' : global ? 'global' : 'default',
      ...(project ? { project } : {}),
      ...(global ? { global } : {}),
    };
  }
  return out;
}

export interface ResolvedBoxAccounts {
  /** Named accounts only — what `CreateBoxRequest.accounts` / `BoxRecord.accounts` carry. */
  accounts: Record<string, string>;
  warnings: string[];
}

/**
 * Resolve the account of every agent a box is for. Throws when a flag names an
 * agent the box is not for, an agent without accounts, or an account the store
 * does not have.
 */
export async function resolveBoxAccounts(o: {
  agents: readonly string[];
  flags?: Record<string, string>;
  config?: Pick<LoadedConfig, 'layers'>;
  store?: AccountStoreOptions;
  /**
   * Agents whose account must be a `login`: a borrowed model-auth lender, whose
   * login travels as a FILE — a pasted token has none to lend.
   */
  loginOnly?: readonly string[];
  /**
   * `false`: resolve only the NAMES, for a create a remote hub runs against its
   * own accounts (llm-accounts Phase 9). The store is not read, and every
   * name that came from a flag or a config layer is returned, an explicit
   * `default` included, so the hub can tell "the PC chose default" from "no
   * choice" (its own default then applies). Default `true`.
   */
  verify?: boolean;
}): Promise<ResolvedBoxAccounts> {
  const flags = o.flags ?? {};
  const warnings: string[] = [];
  const accounts: Record<string, string> = {};
  for (const agent of Object.keys(flags)) {
    if (!o.agents.includes(agent)) {
      throw new Error(
        `--account ${agent}=${flags[agent]}: this box does not carry ${agent} — create it with \`agentbox ${agent} --account ${flags[agent]}\` (or borrow it with --model-auth ${agent})`,
      );
    }
  }
  let file: Awaited<ReturnType<typeof readAccounts>> | undefined;
  for (const agent of o.agents) {
    const spec = findAgentSpec(agent);
    if (!spec) continue;
    if (layerValue(o.config?.layers.workspace.values, spec.id) !== undefined) {
      warnings.push(
        `ignoring ${spec.id}.account from agentbox.yaml: the account is your choice, set it with \`agentbox config set ${spec.id}.account <name>\``,
      );
    }
    const id =
      flags[spec.id] ??
      layerValue(o.config?.layers.project.values, spec.id) ??
      layerValue(o.config?.layers.global.values, spec.id) ??
      DEFAULT_ACCOUNT_ID;
    if (o.verify === false) {
      const chosen =
        flags[spec.id] ??
        layerValue(o.config?.layers.project.values, spec.id) ??
        layerValue(o.config?.layers.global.values, spec.id);
      if (chosen === undefined) continue;
      if (!isDefaultAccount(chosen) && agentAccountKinds(spec).length === 0) {
        throw new Error(`${spec.id} does not support named accounts (account '${chosen}')`);
      }
      accounts[spec.id] = chosen;
      continue;
    }
    if (isDefaultAccount(id)) continue;
    if (agentAccountKinds(spec).length === 0) {
      throw new Error(`${spec.id} does not support named accounts (account '${id}')`);
    }
    file ??= await readAccounts(o.store);
    const row = findAccount(file, spec.id, id);
    if (!row) {
      throw new Error(
        `no ${spec.id} account '${id}' on this machine: add it with \`agentbox credentials add ${spec.id}/${id}\` (see \`agentbox credentials\`)`,
      );
    }
    if (o.loginOnly?.includes(spec.id) && row.kind !== 'login') {
      throw new Error(
        `${spec.id} account '${id}' is a ${row.kind}; a borrowed model-auth login needs a login account`,
      );
    }
    accounts[spec.id] = id;
  }
  return { accounts, warnings };
}

/** The account `agent` runs on in `box`: a named id, or `default`. */
export function boxAccount(box: Pick<BoxRecord, 'accounts'> | undefined, agent: string): string {
  return box?.accounts?.[agent] ?? DEFAULT_ACCOUNT_ID;
}

/** What a box's launch env must do for one agent's account. */
export interface AccountEnvPolicy {
  /** Env to add (a pasted account's token). */
  inject: Record<string, string>;
  /** Host env keys that must NOT reach the agent (its `accountEnv` keys). */
  suppress: string[];
}

export const NO_ACCOUNT_ENV: AccountEnvPolicy = { inject: {}, suppress: [] };

/**
 * The env policy for `spec` on `account`. `default` changes nothing (today's
 * spray). A named account suppresses every `accountEnv` key — so a host API
 * key never shadows a named subscription — and a pasted account injects its
 * own token. A pasted account whose secret is missing injects nothing (the
 * agent then asks to log in), rather than falling back to the host's key.
 */
export async function accountEnvPolicy(
  spec: AgentSyncSpec,
  account: string,
  store?: AccountStoreOptions,
): Promise<AccountEnvPolicy> {
  if (isDefaultAccount(account)) return NO_ACCOUNT_ENV;
  const envMap = spec.accountEnv ?? {};
  const suppress = Object.values(envMap).filter((v): v is string => typeof v === 'string');
  const row = findAccount(await readAccounts(store), spec.id, account);
  if (!row || row.kind === 'login') return { inject: {}, suppress };
  const key = envMap[row.kind];
  const secret = await readAccountSecret(spec.id, account, store);
  const pasted = secret ? decodePastedSecret(secret) : null;
  if (!key || !pasted || pasted.kind !== row.kind) return { inject: {}, suppress };
  return { inject: { [key]: pasted.token }, suppress };
}

/**
 * The suppressed keys a policy does not inject: the ones a launch that adds to
 * an existing env (a docker exec into a container created on another account,
 * a cloud sandbox whose create-time env still holds the old token) must clear
 * explicitly, since leaving a key out of the added env does not remove it.
 */
export function accountEnvClears(policy: AccountEnvPolicy): string[] {
  return policy.suppress.filter((k) => !(k in policy.inject));
}

/** Apply a policy to an env map. Pure. */
export function applyAccountEnv(
  env: Readonly<Record<string, string>>,
  policy: AccountEnvPolicy,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (!policy.suppress.includes(k)) out[k] = v;
  return { ...out, ...policy.inject };
}

/**
 * The boxes whose record names `account` for `agent` — running it, or
 * borrowing it as model auth. While any exist, the account must not be removed:
 * re-adding the same name for another subscription would let a stale box's
 * refresh overwrite it and fan out to every new box on it (#442 review).
 */
export function boxesOnAccount<B extends Pick<BoxRecord, 'name' | 'accounts'>>(
  boxes: readonly B[],
  agent: string,
  account: string,
): B[] {
  return boxes.filter((b) => boxAccount(b, agent) === account && !isDefaultAccount(account));
}
