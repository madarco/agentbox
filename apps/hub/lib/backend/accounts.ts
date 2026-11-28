// Named LLM accounts on a hub create (docs/llm-accounts-plan.md, Phase 3).
// Resolved HERE, against this machine's account store and the project's config
// (never the repo's agentbox.yaml): the box's agent plus every borrowed lender,
// whose account must be a login. A remote control box resolves its creates in
// the worker instead, against the accounts PCs imported into it (Phase 9,
// `account-import.ts`).
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import {
  loadEffectiveConfig,
  setConfigValue,
  tryGetMachineId,
  listProjectsConfigured,
  unsetConfigValue,
} from '@agentbox/config';
import { homedir } from 'node:os';
import {
  accountConfigVolume,
  accountIdProblem,
  accountSecretPath,
  modelAuthSourceId,
  agentAccountKinds,
  findAccount,
  isDefaultAccount,
  namedAccounts,
  normalizeAccountName,
  type AgentSyncSpec,
  type BoxRecord,
  type BoxRuntimeState,
  type LlmAccount,
} from '@agentbox/core';
import type {
  AccountAuthView,
  AccountBackend,
  AccountDefaultView,
  AccountPolicyView,
  AccountRenewView,
  AccountView,
} from '../boxes/backend-types';
import type { LimitsSource } from './account-limits';
import { createAccountImporter, type AccountImporter, type ImportCustody } from './account-import';
import type { HistoryAccountAuth } from './history';
import {
  accountDefaults,
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
  STATE_DIR,
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
  boxes?: () => Promise<readonly AccountBoxFacts[]>;
  /** Plan limits per account (hub settings Phase 3b); absent = none shown. */
  limits?: LimitsSource;
  /**
   * Remove a docker volume. Default: `docker volume rm`. `removed: false` with
   * no `error` = there was no such volume.
   */
  removeVolume?: (name: string) => Promise<{ removed: boolean; error?: string }>;
  store?: AccountStoreOptions;
  /** Where the global config is read and written (tests); default: the home dir. */
  configHome?: string;
  /** This hub's machine id, the `<machine>` its named accounts sit under in custody. */
  machineId?: () => string | undefined;
  /** Credential evidence from the boxes' transcripts; absent = none known. */
  authEvidence?: (subscription: string) => Promise<HistoryAccountAuth | null>;
  /** When the account's stored secret was last written (epoch ms), or null. Default: its mtime. */
  secretWrittenAt?: (agent: string, id: string) => Promise<number | null>;
  /**
   * Fan an account's stored login out to its boxes. Default: the host CLI's
   * `credentials propagate` (the relay's fan-out, run on demand).
   */
  runPropagate?: (agent: string, id: string) => Promise<{ exitCode: number; output: string }>;
  now?: () => number;
  /** The hub's custody store (imports mirror logins there; `rm` cleans it). Null: none. */
  custody?: () => ImportCustody | null;
  /** The importer (tests); default one over `store`, `custody` and `machineId`. */
  importer?: AccountImporter;
}

/** A setup token from `claude setup-token` lives one year. */
const SETUP_TOKEN_LIFE_MS = 365 * 24 * 60 * 60_000;
const EXPIRING_WINDOW_MS = 30 * 24 * 60 * 60_000;

/**
 * Whether an account's credential works, from the evidence (pure):
 * `revoked` while any box's newest refusal is newer than both that box's
 * newest real reply and the stored secret's last write; `expiring` for a setup token in its last
 * 30 days; otherwise `ok`.
 */
export function accountAuthState(
  account: Pick<LlmAccount, 'kind' | 'createdAt'>,
  ev: HistoryAccountAuth | null | undefined,
  secretWrittenAt: number | null,
  nowMs: number,
): AccountAuthView {
  // Per box: one box's working login says nothing about another's (a refresh
  // in one box can rotate the token out from under the rest). The newest
  // still-dead box is the one reported.
  let dead: HistoryAccountAuth['boxes'][number] | undefined;
  let deadAt = -Infinity;
  for (const b of ev?.boxes ?? []) {
    const failed = b.failedAt ? Date.parse(b.failedAt) : NaN;
    if (!Number.isFinite(failed)) continue;
    const ok = b.okAt ? Date.parse(b.okAt) : NaN;
    if (failed <= (Number.isFinite(ok) ? ok : 0) || failed <= (secretWrittenAt ?? 0)) continue;
    if (failed > deadAt) {
      dead = b;
      deadAt = failed;
    }
  }
  if (dead) {
    return {
      state: 'revoked',
      since: dead.failedAt!,
      box: dead.box,
      ...(dead.error ? { detail: dead.error } : {}),
    };
  }
  if (account.kind === 'setup-token') {
    const created = Date.parse(account.createdAt);
    if (Number.isFinite(created)) {
      const expires = created + SETUP_TOKEN_LIFE_MS;
      if (nowMs >= expires - EXPIRING_WINDOW_MS) {
        return { state: 'expiring', since: new Date(expires).toISOString() };
      }
    }
  }
  return { state: 'ok' };
}

/** What the account list reads of a box. */
export type AccountBoxFacts = Pick<BoxRecord, 'name' | 'accounts'> &
  Partial<Pick<BoxRecord, 'agents' | 'borrowedCredentials'>> & {
    cloud?: { lastState?: BoxRuntimeState };
  };

/**
 * The boxes whose usage counts under subscription `agent/id`: every box agent
 * whose `subscriptionOf` is it (the default account included, and a borrower
 * under its lender), plus any box that records the account by name. A box
 * record without `agents` (an old one, a Store-only registration) is counted
 * only by name. Pure apart from `specOf`.
 */
export function boxesOnSubscription<B extends AccountBoxFacts>(
  all: readonly B[],
  agent: string,
  id: string,
  specOf?: Parameters<typeof subscriptionOf>[2],
): B[] {
  const key = `${agent}/${id}`;
  const named = new Set(boxesOnAccount(all, agent, id));
  return all.filter(
    (b) => named.has(b) || (b.agents ?? []).some((a) => subscriptionOf(b, a, specOf) === key),
  );
}

/**
 * A box counts as running unless agentbox last drove a cloud box elsewhere
 * (absent = running). A docker record carries no state: it counts as running,
 * which costs at most one usage call per refresh interval.
 */
const isRunning = (b: AccountBoxFacts): boolean => (b.cloud?.lastState ?? 'running') === 'running';

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

export async function cliPropagate(
  agent: string,
  id: string,
  extra: readonly string[] = [],
): Promise<{ exitCode: number; output: string }> {
  const entry = process.env['AGENTBOX_CLI_ENTRY'];
  if (!entry) throw new Error('hub is missing AGENTBOX_CLI_ENTRY; cannot fan the login out');
  try {
    const r = await execFileAsync(
      process.execPath,
      [
        entry,
        'credentials',
        'propagate',
        '--json',
        '--agent',
        agent,
        ...(isDefaultAccount(id) ? [] : ['--account', id]),
        ...extra,
      ],
      { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return { exitCode: 0, output: `${r.stdout}${r.stderr}` };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      output: `${String(e.stdout ?? '')}${String(e.stderr ?? e.message ?? '')}`,
    };
  }
}

/**
 * The fan-out's outcome from `credentials propagate --json`: its last line is
 * `{"pushed","failed"}`, the rest are the per-target lines. Without that line
 * (it died first) a non-zero exit counts as one failure. Pure.
 */
export function parsePropagateOutput(output: string, exitCode: number): AccountRenewView {
  const lines = output
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    const r = parsed as { pushed?: unknown; failed?: unknown };
    if (typeof r?.pushed === 'number' && typeof r.failed === 'number') {
      return { pushed: r.pushed, failed: r.failed, output: lines.filter((_, j) => j !== i) };
    }
  }
  return { pushed: 0, failed: exitCode === 0 ? 0 : 1, output: lines };
}

export function createAccountBackend(deps: AccountBackendDeps = {}): AccountBackend {
  const boxes = deps.boxes ?? (async () => (await readState()).boxes);
  const removeVolume = deps.removeVolume ?? dockerVolumeRm;
  const store = deps.store;
  const now = deps.now ?? Date.now;
  const runPropagate = deps.runPropagate ?? cliPropagate;
  const machineIdOf = (): string | undefined =>
    deps.machineId ? deps.machineId() : tryGetMachineId();
  const importer =
    deps.importer ??
    createAccountImporter({
      ...(store ? { store } : {}),
      ...(deps.custody ? { custody: deps.custody } : {}),
      machineId: machineIdOf,
      now,
    });
  const secretWrittenAt =
    deps.secretWrittenAt ??
    (async (agent: string, id: string): Promise<number | null> => {
      const spec = findAgentSpec(agent);
      const path = spec ? accountSecretPath(spec, id, store?.stateDir ?? STATE_DIR) : undefined;
      if (!path) return null;
      return (await stat(path).catch(() => null))?.mtimeMs ?? null;
    });

  async function view(
    account: LlmAccount,
    all?: readonly AccountBoxFacts[],
    defaults?: Record<string, AccountDefaultView>,
    imported?: Awaited<ReturnType<AccountImporter['readImports']>>,
  ): Promise<AccountView> {
    const list = all ?? (await boxes().catch(() => []));
    const on = boxesOnSubscription(list, account.agent, account.id);
    const key = `${account.agent}/${account.id}`;
    const [limits, ev, written] = await Promise.all([
      deps.limits?.limitsFor(account.agent, account.id, on.some(isRunning)).catch(() => undefined),
      deps.authEvidence?.(key).catch(() => null),
      secretWrittenAt(account.agent, account.id).catch(() => null),
    ]);
    // With no global setting, the agent's own login IS the global default.
    const d = defaults?.[account.agent];
    const globalId = d ? (d.global ?? 'default') : undefined;
    const isDefault = {
      ...(globalId === account.id ? { global: true as const } : {}),
      ...(d?.project === account.id ? { project: true as const } : {}),
    };
    return {
      agent: account.agent,
      id: account.id,
      kind: account.kind,
      ...(account.identity ? { identity: account.identity } : {}),
      hasSecret: (await readAccountSecret(account.agent, account.id, store)) !== null,
      boxes: on.map((b) => b.name),
      ...(limits ? { limits } : {}),
      auth: accountAuthState(account, ev, written, now()),
      ...(Object.keys(isDefault).length > 0 ? { default: isDefault } : {}),
      ...(() => {
        const from = (imported?.imports ?? [])
          .filter((m) => m.agent === account.agent && m.hubId === account.id)
          .map((m) => ({
            machine: m.machine,
            ...(m.machineLabel ? { machineLabel: m.machineLabel } : {}),
            id: m.localId,
          }));
        return from.length > 0 ? { importedFrom: from } : {};
      })(),
    };
  }

  /** Agents that can hold accounts, per the registry (or the test store's specs). */
  function accountAgents(): AgentSyncSpec[] {
    return (store?.specs ?? AGENT_SYNC_SPECS).filter(
      (s) => agentAccountKinds(s).length > 0 && !s.hidden,
    );
  }

  /**
   * A project folder from a client, or a message: absolute, a directory, and
   * (`write`) inside a git checkout or an agentbox.yaml project, so a client
   * cannot plant project config on an arbitrary folder of the hub's machine.
   */
  async function projectProblem(project: unknown, write = false): Promise<string | null> {
    if (typeof project !== 'string' || !isAbsolute(project)) {
      return 'project must be an absolute folder path';
    }
    const st = await stat(project).catch(() => null);
    if (!st?.isDirectory()) return `no such folder: ${project}`;
    if (!write) return null;
    for (let dir = project; ; dir = dirname(dir)) {
      for (const marker of ['.git', 'agentbox.yaml']) {
        if (await stat(join(dir, marker)).catch(() => null)) return null;
      }
      if (dirname(dir) === dir) break;
    }
    return `not a project (no git checkout or agentbox.yaml): ${project}`;
  }

  /**
   * Throws on an unreadable config: reporting every agent as `default` then
   * would badge the wrong account.
   */
  async function defaultsFor(project?: string): Promise<Record<string, AccountDefaultView>> {
    // Without a project, only the global layer counts: the hub's own cwd is no
    // project of the user's.
    const cfg = await loadEffectiveConfig(project ?? configHome);
    const layers = project
      ? cfg.layers
      : { ...cfg.layers, project: { ...cfg.layers.project, values: {} } };
    return accountDefaults(
      accountAgents().map((s) => s.id),
      { layers },
    );
  }

  const configError = (err: unknown): string =>
    `cannot read the config: ${err instanceof Error ? err.message : String(err)}`;

  /**
   * Drop every `<agent>.account` setting that names a removed account: the
   * global one and each known project's. Left in place, the next create there
   * would fail on an account that no longer exists. Returns what it cleared
   * (`global`, or the project folder).
   */
  async function clearDefaultsNaming(
    agent: string,
    id: string,
  ): Promise<{ cleared: string[]; errors: string[] }> {
    const key = `${agent}.account`;
    const cleared: string[] = [];
    const errors: string[] = [];
    // Each layer on its own: one unreadable config must not stop the rest, and
    // never fails the removal that already happened.
    const clear = async (
      where: string,
      scope: 'global' | 'project',
      dir: string,
      project?: string,
    ) => {
      try {
        const d = (await defaultsFor(project))[agent];
        if ((scope === 'global' ? d?.global : d?.project) !== id) return;
        await unsetConfigValue(scope, key, dir);
        cleared.push(where);
      } catch (err) {
        errors.push(`${where}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await clear('global', 'global', configHome);
    let projects: Awaited<ReturnType<typeof listProjectsConfigured>> = [];
    try {
      projects = await listProjectsConfigured();
    } catch (err) {
      errors.push(`projects: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const p of projects) {
      if (p.hasConfigFile) await clear(p.originalPath, 'project', p.originalPath, p.originalPath);
    }
    return { cleared, errors };
  }

  function specOf(agent: unknown): AgentSyncSpec | null {
    return typeof agent === 'string' ? (findAgentSpec(agent) ?? null) : null;
  }

  const configHome = deps.configHome ?? homedir();
  async function policy(): Promise<AccountPolicyView> {
    const cfg = await loadEffectiveConfig(configHome).catch(() => null);
    return { onLimit: cfg?.effective.accounts?.onLimit === 'switch' ? 'switch' : 'ask' };
  }

  return {
    getAccountPolicy: policy,
    async setAccountPolicy(input) {
      const onLimit = (input as { onLimit?: unknown } | null)?.onLimit;
      if (onLimit !== 'ask' && onLimit !== 'switch') {
        return { ok: false, code: 'invalid_request', error: 'onLimit must be "ask" or "switch"' };
      }
      await setConfigValue('global', 'accounts.onLimit', onLimit, configHome);
      return { ok: true, value: await policy() };
    },
    async listAccounts(opts = {}) {
      const { accounts } = await readAccounts(store);
      const all = await boxes().catch(() => []);
      const project =
        opts.project && !(await projectProblem(opts.project)) ? opts.project : undefined;
      // An unreadable config lists the accounts without default marks, and says so.
      let defaults: Record<string, AccountDefaultView> | undefined;
      let defaultsError: string | undefined;
      try {
        defaults = await defaultsFor(project);
      } catch (err) {
        defaultsError = configError(err);
      }
      const imported = await importer.readImports().catch(() => undefined);
      const views = await Promise.all(accounts.map((a) => view(a, all, defaults, imported)));
      const agents = accountAgents().map((s) => ({ id: s.id, kinds: agentAccountKinds(s) }));
      // A machine with no id yet (unwritable HOME) lists its accounts without one.
      const machine = machineIdOf();
      return {
        accounts: views,
        agents,
        ...(defaults ? { defaults } : { defaultsError: defaultsError! }),
        ...(machine ? { machine } : {}),
      };
    },

    async getAccountDefaults(opts = {}) {
      if (opts.project !== undefined) {
        const problem = await projectProblem(opts.project);
        if (problem) return { ok: false, code: 'invalid_request', error: problem };
      }
      try {
        return { ok: true, value: await defaultsFor(opts.project) };
      } catch (err) {
        return { ok: false, code: 'conflict', error: configError(err) };
      }
    },

    async setAccountDefault(input) {
      const b = (input ?? {}) as Record<string, unknown>;
      const spec = specOf(b.agent);
      if (!spec || agentAccountKinds(spec).length === 0) {
        return {
          ok: false,
          code: 'invalid_request',
          error: 'unknown agent, or one without accounts',
        };
      }
      const scope = b.scope ?? 'global';
      if (scope !== 'global' && scope !== 'project') {
        return { ok: false, code: 'invalid_request', error: 'scope must be "global" or "project"' };
      }
      let project: string | undefined;
      if (scope === 'project') {
        const problem = await projectProblem(b.project, true);
        if (problem) return { ok: false, code: 'invalid_request', error: problem };
        project = b.project as string;
      }
      if (b.account !== null && typeof b.account !== 'string') {
        return { ok: false, code: 'invalid_request', error: 'account must be a string or null' };
      }
      const key = `${spec.id}.account`;
      const cwd = project ?? configHome;
      if (b.account === null) {
        await unsetConfigValue(scope, key, cwd);
      } else {
        const id = b.account.trim();
        const problem = accountIdProblem(id);
        if (problem) return { ok: false, code: 'invalid_request', error: problem };
        // `default` is the agent's own login: always a valid choice, signed in or not.
        if (!isDefaultAccount(id) && !findAccount(await readAccounts(store), spec.id, id)) {
          return {
            ok: false,
            code: 'not_found',
            error: `no ${spec.id} account '${id}' on this machine (see \`agentbox credentials\`)`,
          };
        }
        await setConfigValue(scope, key, id, cwd);
      }
      try {
        return { ok: true, value: await defaultsFor(project) };
      } catch (err) {
        return { ok: false, code: 'conflict', error: configError(err) };
      }
    },

    async renewAccount(agent, id) {
      const spec = specOf(agent);
      if (!spec) return { ok: false, code: 'not_found', error: 'unknown agent' };
      const row = findAccount(await readAccounts(store), spec.id, id);
      if (!row) return { ok: false, code: 'not_found', error: `no ${spec.id} account '${id}'` };
      if (row.kind !== 'login') {
        return {
          ok: false,
          code: 'invalid_request',
          error: `${spec.id}/${id} is a ${row.kind}: remove it and add the new one (\`agentbox credentials add\`)`,
        };
      }
      const r = await runPropagate(spec.id, row.id);
      const value = parsePropagateOutput(r.output, r.exitCode);
      if (r.exitCode !== 0 && value.pushed === 0 && value.failed === 0) {
        return {
          ok: false,
          code: 'conflict',
          error: value.output.slice(-3).join('\n') || 'fan-out failed',
        };
      }
      return { ok: true, value };
    },

    async addPastedAccount(input) {
      const b = (input ?? {}) as Record<string, unknown>;
      const spec = specOf(b.agent);
      if (!spec) return { ok: false, code: 'invalid_request', error: 'unknown agent' };
      if (b.kind !== 'api-key' && b.kind !== 'setup-token') {
        return {
          ok: false,
          code: 'invalid_request',
          error: `kind must be api-key or setup-token; sign a login in with \`agentbox credentials add ${spec.id}/<name> --login\``,
        };
      }
      const token = typeof b.token === 'string' ? b.token.trim() : '';
      // An existing id is taken as is (older ones may hold '-'); a new name is
      // normalized ("Work Max" -> work_max) or refused.
      const rawId = typeof b.id === 'string' ? b.id.trim() : '';
      let id = rawId;
      if (rawId && !findAccount(await readAccounts(store), spec.id, rawId)) {
        const n = normalizeAccountName(rawId);
        if (n.problem !== undefined)
          return { ok: false, code: 'invalid_request', error: n.problem };
        id = n.name;
      }
      let req: ReturnType<typeof resolveLoginAccount>;
      try {
        req = resolveLoginAccount(spec, {
          account: id,
          ...(b.kind === 'api-key' ? { apiKey: true } : { setupToken: true }),
        });
      } catch (err) {
        return { ok: false, code: 'invalid_request', error: (err as Error).message };
      }
      if (!req)
        return { ok: false, code: 'invalid_request', error: 'a named account id is required' };
      const problem = pastedSecretProblem(token);
      if (problem) return { ok: false, code: 'invalid_request', error: problem };
      const existing = findAccount(await readAccounts(store), spec.id, req.id);
      // `replace`: a new token for the same account (a rotated or expiring setup
      // token), so boxes on it need not be moved off first. Same kind only.
      const replace = b.replace === true;
      if (existing && (!replace || existing.kind !== req.kind)) {
        return {
          ok: false,
          code: 'conflict',
          error:
            replace && existing.kind !== req.kind
              ? `${spec.id} account '${req.id}' is a ${existing.kind}; remove it first`
              : `${spec.id} account '${req.id}' already exists; remove it first, or replace its token`,
        };
      }
      if (replace && !existing) {
        return {
          ok: false,
          code: 'not_found',
          error: `no ${spec.id} account '${req.id}' to replace`,
        };
      }
      // From here a failure is the hub's (disk, permissions), not the input's:
      // it propagates and the route answers 500. A new token restarts the
      // setup token's year, so `createdAt` moves with it.
      const row: LlmAccount = {
        agent: spec.id,
        id: req.id,
        kind: req.kind,
        createdAt: new Date(now()).toISOString(),
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
        if (existing) await upsertAccount(existing, store).catch(() => {});
        else await removeStoredAccount(spec.id, req.id, store).catch(() => {});
        throw err;
      }
      // Set on the hub itself: no PC's import replaces this token after it
      // (a PC holding the old one would put it back otherwise).
      await importer.clearSetter(spec.id, req.id).catch(() => {});
      return { ok: true, value: await view(row) };
    },

    async importAccounts(input) {
      const items = (input as { items?: unknown } | null)?.items;
      if (!Array.isArray(items) || items.length === 0) {
        return { ok: false, code: 'invalid_request', error: 'items must be a non-empty array' };
      }
      if (items.length > 64) {
        return { ok: false, code: 'invalid_request', error: 'at most 64 items per import' };
      }
      return { ok: true, value: await importer.importItems(items) };
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
      // With its custody copies (the hub's and every PC's it was imported
      // from) and its import mappings, so a PC's next automatic push does not
      // bring it back. One chain with the importer: no import lands mid-removal.
      await importer.forgetAccount(spec.id, id, async () => {
        await removeStoredAccount(spec.id, id, store);
      });
      deps.limits?.forget(spec.id, id);
      const volume = accountConfigVolume(spec.dockerVolume, id);
      const r = await removeVolume(volume);
      const { cleared: defaultsCleared, errors } = await clearDefaultsNaming(spec.id, id);
      return {
        ok: true,
        value: {
          volumeRemoved: r.removed,
          ...(r.error ? { volumeError: `could not remove ${volume}: ${r.error}` } : {}),
          ...(defaultsCleared.length > 0 ? { defaultsCleared } : {}),
          ...(errors.length > 0
            ? { defaultsError: `could not check the settings naming it: ${errors.join('; ')}` }
            : {}),
        },
      };
    },
  };
}

/** One box's named accounts, as the Box payload shows them (`Box.accountsInfo`). */
export interface BoxAccountInfo {
  agent: string;
  account: string;
  kind?: LlmAccount['kind'];
}

/**
 * The kind of each of a box's named accounts, from the hub machine's
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
      ...(row ? { kind: row.kind } : {}),
    };
  });
}

/**
 * The subscription an agent's usage in a box counts under, as `agent/account`
 * (hub settings Phase 3a). An agent that runs on another agent's login
 * (`--model-auth`, `BoxRecord.borrowedCredentials`) spends the lender's plan,
 * so its sessions count under the lender's account. Only the box's sources the
 * agent itself declares (`modelAuth.sources`) count: the borrow list is
 * box-wide, and an agent on its own login in the same box keeps its own.
 *
 * No guessing: a lender is used only when it is the ONE source the agent
 * consumes. Mixed with an `env:` key, or two lenders, a turn could be served by
 * either, so the session stays on the agent's own key (hub settings backlog:
 * per-turn attribution). Pure apart from the default `specOf` registry lookup.
 */
export function subscriptionOf(
  box: Pick<BoxRecord, 'accounts' | 'borrowedCredentials'>,
  agent: string,
  specOf: (agent: string) => Pick<AgentSyncSpec, 'modelAuth'> | undefined = findAgentSpec,
): string {
  const declared = new Set((specOf(agent)?.modelAuth?.sources ?? []).map(modelAuthSourceId));
  const consumed = (box.borrowedCredentials ?? []).filter((id) => id !== agent && declared.has(id));
  const only = consumed.length === 1 ? consumed[0]! : undefined;
  const owner = only && !only.startsWith('env:') ? only : agent;
  return `${owner}/${box.accounts?.[owner] ?? 'default'}`;
}

/**
 * Every agent's subscription in a box (`Box.subscriptions`), for the agents the
 * box was created for: its own agents, else its last agent. Undefined when the
 * box names no agent. Pure apart from the default registry lookup.
 */
export function subscriptionsOf(
  box: Pick<BoxRecord, 'accounts' | 'borrowedCredentials'> & {
    agents?: readonly string[];
    lastAgent?: string;
  },
  specOf?: Parameters<typeof subscriptionOf>[2],
): Record<string, string> | undefined {
  const agents = box.agents?.length ? box.agents : box.lastAgent ? [box.lastAgent] : [];
  if (agents.length === 0) return undefined;
  return Object.fromEntries(agents.map((a) => [a, subscriptionOf(box, a, specOf)]));
}

/**
 * Agents that can run on another agent's login (an `agent` model-auth source):
 * the history store re-derives their pre-3a account stamps
 * (`HistoryRepoOptions.borrowingAgents`).
 */
export function borrowingAgentIds(
  specs: readonly Pick<AgentSyncSpec, 'id' | 'modelAuth'>[] = AGENT_SYNC_SPECS,
): string[] {
  return specs
    .filter((s) => (s.modelAuth?.sources ?? []).some((src) => src.kind === 'agent'))
    .map((s) => s.id);
}
