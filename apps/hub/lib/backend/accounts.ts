// Named LLM accounts on a hub create (docs/llm-accounts-plan.md, Phase 3).
// Resolved HERE, against this machine's account store and the project's config
// (never the repo's agentbox.yaml): the box's agent plus every borrowed lender,
// whose account must be a login. A remote control box has no account store yet
// (Phase 5), so a named account is refused there with a message naming it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadEffectiveConfig } from '@agentbox/config';
import {
  accountConfigVolume,
  agentAccountKinds,
  findAccount,
  isDefaultAccount,
  namedAccounts,
  type AgentSyncSpec,
  type BoxRecord,
  type LlmAccount,
} from '@agentbox/core';
import type { AccountBackend, AccountView } from '../boxes/backend-types';
import {
  AGENT_SYNC_SPECS,
  boxesOnAccount,
  encodePastedSecret,
  findAgentSpec,
  pastedSecretProblem,
  readAccounts,
  readAccountSecret,
  readState,
  removeAccount as removeStoredAccount,
  resolveBoxAccounts,
  resolveLoginAccount,
  upsertAccount,
  writeAccountSecret,
  type AccountStoreOptions,
} from '@agentbox/sandbox-core';

export async function resolveCreateAccounts(o: {
  workspace: string;
  agent?: string;
  /** The client's `opts.accounts` (flags). */
  accounts?: Record<string, string>;
  /** Resolved model-auth sources; `env:` ids carry no account. */
  borrowCredentials: readonly string[];
}): Promise<Record<string, string>> {
  const lenders = o.borrowCredentials.filter((id) => !id.startsWith('env:'));
  // An agentless box carries only its lenders, so only they can be named.
  const agents = o.agent ? [o.agent, ...lenders] : lenders;
  const r = await resolveBoxAccounts({
    agents,
    ...(o.accounts ? { flags: o.accounts } : {}),
    config: await loadEffectiveConfig(o.workspace),
    loginOnly: lenders,
  });
  return r.accounts;
}

/**
 * Why a box may not become the project's DEFAULT checkpoint, or null. A box on
 * a named account carries that account's login in its filesystem (cloud), so
 * every later default box would run — and refresh, and post — account B as if
 * it were the owner's default (#437 review, finding 7).
 */
export function setDefaultCheckpointRefusal(box: {
  name: string;
  accounts?: Readonly<Record<string, string>>;
}): string | null {
  const named = namedAccounts(box.accounts);
  if (!named) return null;
  const list = Object.entries(named)
    .map(([a, n]) => `${a}=${n}`)
    .join(', ');
  return `box ${box.name} runs on a named account (${list}); a project default checkpoint must come from a box on the default account`;
}

// ---------------------------------------------------------------------------
// The account list surface (Phase 5): `/api/v1/accounts`. An account is a fact
// about the machine that owns the store, so this answers for THIS hub's machine.
// No route ever returns a secret.

export interface AccountBackendDeps {
  /** The hub machine's box records. Default: `~/.agentbox/state.json`. */
  boxes?: () => Promise<readonly Pick<BoxRecord, 'name' | 'accounts'>[]>;
  /**
   * Remove a docker volume. Default: `docker volume rm`. `removed: false` with
   * no `error` = there was no such volume.
   */
  removeVolume?: (name: string) => Promise<{ removed: boolean; error?: string }>;
  store?: AccountStoreOptions;
}

const execFileAsync = promisify(execFile);

async function dockerVolumeRm(name: string): Promise<{ removed: boolean; error?: string }> {
  try {
    await execFileAsync('docker', ['volume', 'rm', name]);
    return { removed: true };
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? (err as Error).message ?? '');
    if (/no such volume/i.test(stderr)) return { removed: false };
    // Still mounted by a container, or docker itself failed: say so — a stale
    // login volume left behind would be mounted by a re-added account.
    return { removed: false, error: stderr.trim() || 'docker volume rm failed' };
  }
}

export function createAccountBackend(deps: AccountBackendDeps = {}): AccountBackend {
  const boxes = deps.boxes ?? (async () => (await readState()).boxes);
  const removeVolume = deps.removeVolume ?? dockerVolumeRm;
  const store = deps.store;

  async function view(account: LlmAccount): Promise<AccountView> {
    const all = await boxes().catch(() => []);
    return {
      agent: account.agent,
      id: account.id,
      ...(account.label ? { label: account.label } : {}),
      kind: account.kind,
      ...(account.identity ? { identity: account.identity } : {}),
      hasSecret: (await readAccountSecret(account.agent, account.id, store)) !== null,
      boxes: boxesOnAccount(all, account.agent, account.id).map((b) => b.name),
    };
  }

  function specOf(agent: unknown): AgentSyncSpec | null {
    return typeof agent === 'string' ? (findAgentSpec(agent) ?? null) : null;
  }

  return {
    async listAccounts() {
      const { accounts } = await readAccounts(store);
      const all = await boxes().catch(() => []);
      const views: AccountView[] = [];
      for (const a of accounts) {
        views.push({
          agent: a.agent,
          id: a.id,
          ...(a.label ? { label: a.label } : {}),
          kind: a.kind,
          ...(a.identity ? { identity: a.identity } : {}),
          hasSecret: (await readAccountSecret(a.agent, a.id, store)) !== null,
          // The default account is every box without a record; counting them is
          // a fleet listing, not an account fact.
          boxes: isDefaultAccount(a.id)
            ? []
            : boxesOnAccount(all, a.agent, a.id).map((b) => b.name),
        });
      }
      const agents = (store?.specs ?? AGENT_SYNC_SPECS)
        .filter((s) => agentAccountKinds(s).length > 0 && !s.hidden)
        .map((s) => ({ id: s.id, kinds: agentAccountKinds(s) }));
      return { accounts: views, agents };
    },

    async addPastedAccount(input) {
      const b = (input ?? {}) as Record<string, unknown>;
      const spec = specOf(b.agent);
      if (!spec) return { ok: false, code: 'invalid_request', error: 'unknown agent' };
      if (b.kind !== 'api-key' && b.kind !== 'setup-token') {
        return {
          ok: false,
          code: 'invalid_request',
          error: `kind must be api-key or setup-token; sign a login in with \`agentbox ${spec.id} login --account <name>\``,
        };
      }
      const token = typeof b.token === 'string' ? b.token.trim() : '';
      const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim() : undefined;
      let req: ReturnType<typeof resolveLoginAccount>;
      try {
        req = resolveLoginAccount(spec, {
          account: typeof b.id === 'string' ? b.id : '',
          ...(b.kind === 'api-key' ? { apiKey: true } : { setupToken: true }),
          ...(label ? { label } : {}),
        });
      } catch (err) {
        return { ok: false, code: 'invalid_request', error: (err as Error).message };
      }
      if (!req)
        return { ok: false, code: 'invalid_request', error: 'a named account id is required' };
      const problem = pastedSecretProblem(token);
      if (problem) return { ok: false, code: 'invalid_request', error: problem };
      const existing = findAccount(await readAccounts(store), spec.id, req.id);
      if (existing) {
        return {
          ok: false,
          code: 'conflict',
          error: `${spec.id} account '${req.id}' already exists; remove it first`,
        };
      }
      // From here a failure is the hub's (disk, permissions), not the input's:
      // it propagates and the route answers 500.
      const row: LlmAccount = {
        agent: spec.id,
        id: req.id,
        kind: req.kind,
        createdAt: new Date().toISOString(),
        ...(label ? { label } : {}),
      };
      await upsertAccount(row, store);
      try {
        await writeAccountSecret(
          spec.id,
          req.id,
          encodePastedSecret({ kind: req.kind as 'api-key' | 'setup-token', token }),
          store,
        );
      } catch (err) {
        await removeStoredAccount(spec.id, req.id, store).catch(() => {});
        throw err;
      }
      return { ok: true, value: await view(row) };
    },

    async labelAccount(agent, id, label) {
      const spec = specOf(agent);
      if (!spec) return { ok: false, code: 'not_found', error: 'unknown agent' };
      const existing = findAccount(await readAccounts(store), spec.id, id);
      if (!existing)
        return { ok: false, code: 'not_found', error: `no ${spec.id} account '${id}'` };
      if (label !== null && typeof label !== 'string') {
        return { ok: false, code: 'invalid_request', error: 'label must be a string or null' };
      }
      const next: LlmAccount = { ...existing };
      const text = typeof label === 'string' ? label.trim() : '';
      if (text) next.label = text;
      else delete next.label;
      await upsertAccount(next, store);
      return { ok: true, value: await view(next) };
    },

    async removeAccount(agent, id) {
      const spec = specOf(agent);
      if (!spec) return { ok: false, code: 'not_found', error: 'unknown agent' };
      if (isDefaultAccount(id)) {
        return {
          ok: false,
          code: 'invalid_request',
          error: `the default account is the agent's own login; sign in again with \`agentbox ${spec.id} login\``,
        };
      }
      if (!findAccount(await readAccounts(store), spec.id, id)) {
        return { ok: false, code: 'not_found', error: `no ${spec.id} account '${id}'` };
      }
      // Never while a box records it (#442 review): re-adding the name for
      // another subscription would let that box's refresh overwrite it.
      const inUse = boxesOnAccount(await boxes(), spec.id, id);
      if (inUse.length > 0) {
        return {
          ok: false,
          code: 'conflict',
          error: `${spec.id} account '${id}' is still used by ${inUse.map((b) => b.name).join(', ')}`,
        };
      }
      await removeStoredAccount(spec.id, id, store);
      const volume = accountConfigVolume(spec.dockerVolume, id);
      const r = await removeVolume(volume);
      return {
        ok: true,
        value: {
          volumeRemoved: r.removed,
          ...(r.error ? { volumeError: `could not remove ${volume}: ${r.error}` } : {}),
        },
      };
    },
  };
}

/** One box's named accounts, as the Box payload shows them (`Box.accountsInfo`). */
export interface BoxAccountInfo {
  agent: string;
  account: string;
  label?: string;
  kind?: LlmAccount['kind'];
}

/**
 * Label and kind for each of a box's named accounts, from the hub machine's
 * store. An account the store no longer has (removed, or a box adopted from
 * another machine) keeps just its id. Pure.
 */
export function accountsInfoOf(
  accounts: Readonly<Record<string, string>> | undefined,
  file: { accounts: readonly LlmAccount[] } | null,
): BoxAccountInfo[] | undefined {
  const named = namedAccounts(accounts);
  if (!named) return undefined;
  return Object.entries(named).map(([agent, account]) => {
    const row = file?.accounts.find((a) => a.agent === agent && a.id === account);
    return {
      agent,
      account,
      ...(row?.label ? { label: row.label } : {}),
      ...(row ? { kind: row.kind } : {}),
    };
  });
}
