// Hub-owned subscriptions on a remote hub (docs/llm-accounts-plan.md, Phase 9).
//
// A PC's logins and keys are IMPORTED into this hub's own account store, so the
// existing list / resolve / seed / switch / fan-out paths serve them unchanged.
// Which PC account each hub account came from lives beside the store, in
// `account-imports.json`, never on the `LlmAccount` row. The decisions (dedupe,
// collision, mapping, tombstone, create-time resolution) are pure functions
// here; `createAccountImporter` applies them to the store and custody.
import { readFile, rename, writeFile, mkdir, chmod } from 'node:fs/promises';
import { withFileLock } from '@agentbox/config';
import { join, dirname } from 'node:path';
import {
  ACCOUNTS_CUSTODY_SEGMENT,
  accountCustodyPath,
  accountIdProblem,
  accountSecretPath,
  agentAccountKinds,
  DEFAULT_ACCOUNT_ID,
  findAccount,
  isDefaultAccount,
  type AgentSyncSpec,
  type LlmAccount,
  type LlmAccountIdentity,
  type LlmAccountKind,
} from '@agentbox/core';
import {
  AGENT_SYNC_SPECS,
  credentialExpiry,
  decodePastedSecret,
  findAgentSpec,
  isRealAgentCredential,
  readAccounts,
  readAccountSecret,
  readCredentialBackup,
  removeAccount as removeStoredAccount,
  shouldAcceptCredentialBlob,
  STATE_DIR,
  upsertAccount,
  writeAccountSecret,
  writeCredentialBackup,
  type AccountStoreOptions,
} from '@agentbox/sandbox-core';

// ---------------------------------------------------------------------------
// The mapping file.

/** One PC account that went into a hub account. */
export interface AccountImportMapping {
  agent: string;
  /** The PC's machine id. */
  machine: string;
  /** The PC's own name for it. */
  localId: string;
  /** The hub account it lives in. */
  hubId: string;
  machineLabel?: string;
  at: string;
}

/** A mapping whose hub account was removed: the PC's next automatic push must not bring it back. */
export interface AccountImportTombstone {
  agent: string;
  machine: string;
  localId: string;
  at: string;
}

/**
 * The machine whose import last set a pasted account's token. Only it may
 * replace that token by import, so two PCs sharing a key never flip it back
 * and forth (the last one to push a stale copy winning). A token replaced on
 * the hub itself is marked {@link SET_ON_HUB}: no import replaces it then. No
 * entry at all (an account imported before this rule) lets the machine whose
 * own name maps to it replace it, and records that machine.
 */
export interface PastedSetter {
  agent: string;
  hubId: string;
  machine: string;
}

export interface AccountImportsFile {
  version: 1;
  imports: AccountImportMapping[];
  removed: AccountImportTombstone[];
  setBy?: PastedSetter[];
}

export const EMPTY_IMPORTS: AccountImportsFile = { version: 1, imports: [], removed: [] };

/** `setBy` marker for a token set on the hub itself (a machine id is a UUID). */
export const SET_ON_HUB = ':hub';

/**
 * Whether an import from `machine` may replace a pasted hub account's token
 * that differs from its own (pure): it set the current one, or nothing is
 * recorded and the item reached the account through its own mapping.
 */
export function mayReplacePasted(
  file: AccountImportsFile,
  agent: string,
  hubId: string,
  machine: string,
  viaMapping: boolean,
): boolean {
  const setter = (file.setBy ?? []).find((x) => x.agent === agent && x.hubId === hubId);
  return setter ? setter.machine === machine : viaMapping;
}

/** `file` with `agent/hubId`'s setter set to `machine` (or cleared with null). Pure. */
export function withSetter(
  file: AccountImportsFile,
  agent: string,
  hubId: string,
  machine: string | null,
): AccountImportsFile {
  const rest = (file.setBy ?? []).filter((x) => !(x.agent === agent && x.hubId === hubId));
  const setBy = machine ? [...rest, { agent, hubId, machine }] : rest;
  const { setBy: _old, ...base } = file;
  void _old;
  return setBy.length > 0 ? { ...base, setBy } : base;
}

export function accountImportsPath(stateDir: string = STATE_DIR): string {
  return join(stateDir, 'account-imports.json');
}

/** Malformed entries are dropped; an unreadable file reads as empty. Pure. */
export function parseImportsFile(text: string | null): AccountImportsFile {
  if (!text) return { ...EMPTY_IMPORTS, imports: [], removed: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...EMPTY_IMPORTS, imports: [], removed: [] };
  }
  const r = (raw ?? {}) as { imports?: unknown; removed?: unknown };
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const imports = (Array.isArray(r.imports) ? r.imports : []).filter(
    (m): m is AccountImportMapping => {
      const x = m as Partial<AccountImportMapping>;
      return str(x.agent) && str(x.machine) && str(x.localId) && str(x.hubId);
    },
  );
  const removed = (Array.isArray(r.removed) ? r.removed : []).filter(
    (m): m is AccountImportTombstone => {
      const x = m as Partial<AccountImportTombstone>;
      return str(x.agent) && str(x.machine) && str(x.localId);
    },
  );
  const setBy = (
    Array.isArray((r as { setBy?: unknown }).setBy)
      ? ((r as { setBy: unknown[] }).setBy as unknown[])
      : []
  ).filter((m): m is PastedSetter => {
    const x = m as Partial<PastedSetter>;
    return str(x.agent) && str(x.hubId) && str(x.machine);
  });
  return setBy.length > 0
    ? { version: 1, imports, removed, setBy }
    : { version: 1, imports, removed };
}

// ---------------------------------------------------------------------------
// The import decision (pure).

/** What a PC sends per login or key (`POST /api/v1/accounts/import`). */
export interface AccountImportItem {
  agent: string;
  /** The PC's own name (`default` for the agent's own login). */
  id: string;
  kind: LlmAccountKind;
  identity?: LlmAccountIdentity;
  /** The login file, or the `{kind, token}` encoding of a pasted kind. */
  secret: string;
  machine: string;
  machineLabel?: string;
  /** Bring back a mapping removed on the hub. */
  force?: boolean;
}

export type ImportAction =
  | 'created'
  | 'merged'
  | 'updated'
  | 'kept'
  | 'renamed'
  | 'removed'
  | 'refused';

export interface ImportResult {
  agent: string;
  id: string;
  hubId?: string;
  action: ImportAction;
  reason: string;
}

/** Where an item goes, before any write. */
export type ImportTarget =
  | {
      to: 'existing';
      hubId: string;
      why: 'mapping' | 'identity' | 'same-token';
    }
  | { to: 'new'; hubId: string; renamedFrom?: string }
  | { to: 'removed' };

const emailOf = (i?: LlmAccountIdentity): string | undefined => i?.email?.trim().toLowerCase();

/**
 * The owner of a login blob, from the agent's declared `credential.identity`
 * paths (claude: `claudeAiOauth.accountUuid` + `organizationUuid`; codex:
 * `tokens.account_id`), joined; null unless every path holds a string. Read off
 * the secret itself, so it is known even when the row has no email. Pure.
 */
export function credentialOwnerKey(
  spec: Pick<AgentSyncSpec, 'credential'> | undefined,
  text: string | null,
): string | null {
  const paths = spec?.credential?.identity?.jsonPaths ?? [];
  if (!text || paths.length === 0) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const values: string[] = [];
  for (const path of paths) {
    let cur: unknown = doc;
    for (const seg of path) cur = (cur as Record<string, unknown> | null)?.[seg];
    if (typeof cur !== 'string' || cur.length === 0) return null;
    values.push(cur);
  }
  return values.join('/');
}

/** Both identities name the same subscription: same email, orgs not in conflict. Pure. */
export function sameIdentity(a?: LlmAccountIdentity, b?: LlmAccountIdentity): boolean {
  const ea = emailOf(a);
  const eb = emailOf(b);
  if (!ea || !eb || ea !== eb) return false;
  return !a?.org || !b?.org || a.org === b.org;
}

/** Both known and different: certainly two subscriptions. Pure. */
export function identityConflict(a?: LlmAccountIdentity, b?: LlmAccountIdentity): boolean {
  const ea = emailOf(a);
  const eb = emailOf(b);
  if (ea && eb && ea !== eb) return true;
  return Boolean(a?.org && b?.org && a.org !== b.org);
}

/**
 * Whether an imported LOGIN may replace the hub's copy (pure). A refresh
 * revokes every older copy, so the hub keeps the NEWEST: ordered by when the
 * access token expires (`credentialExpiry`: the agent's freshness field, else
 * the JWT `exp` of `tokens.access_token`, which is how codex is ordered: it
 * declares no freshness field, so a content-only compare took a PC's dead copy
 * over the hub's refreshed one). Unknown on either side: the agent's own
 * freshness rule (content changed, for an agent with no order at all).
 */
export function importLoginVerdict(
  spec: Pick<AgentSyncSpec, 'id' | 'credential'>,
  incoming: string,
  existing: string | null,
): { accept: boolean; reason: string } {
  if (existing === null) return { accept: true, reason: 'no copy on the hub' };
  if (existing === incoming) return { accept: false, reason: 'unchanged' };
  const expiry = (text: string): number | null => {
    try {
      return credentialExpiry(spec.id, text);
    } catch {
      return null;
    }
  };
  const mine = expiry(incoming);
  const theirs = expiry(existing);
  if (mine !== null && theirs !== null) {
    return mine > theirs
      ? { accept: true, reason: 'newer login' }
      : { accept: false, reason: "not newer than the hub's copy" };
  }
  return shouldAcceptCredentialBlob(spec.credential?.freshness?.jsonPath, incoming, existing);
}

/**
 * A free id for `base`: `base` itself, else `base_2`, `base_3`, … with the base
 * cut so the result fits the 32-character id grammar. Pure.
 */
export function freeAccountId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `_${String(n)}`;
    const cut = base.slice(0, 32 - suffix.length).replace(/[_-]+$/, '');
    const id = `${cut || 'acct'}${suffix}`;
    if (!taken.has(id) && accountIdProblem(id) === null) return id;
  }
  throw new Error(`no free account id for '${base}'`);
}

/**
 * Where one NAMED item lands in the hub's store (pure). Order:
 *
 * 1. a tombstoned mapping (removed on the hub) stays removed unless `force`;
 * 2. the item's own mapping, unless the PC re-signed that name into another
 *    subscription (both identities known and different) or changed its kind;
 * 3. a login of the same identity (two PCs on one subscription), or a pasted
 *    account of the same kind holding the same token;
 * 4. else a new hub account under the PC's id, suffixed when the id is taken.
 *
 * Never targets `default` (its own slot, imported separately).
 */
export function planAccountImport(o: {
  item: Pick<AccountImportItem, 'agent' | 'id' | 'kind' | 'identity' | 'machine' | 'force'>;
  /** The hub's NAMED rows of the item's agent. */
  rows: readonly LlmAccount[];
  imports: AccountImportsFile;
  /** The stored secret of a pasted hub row (same-token dedupe); null when none. */
  pastedSecretOf: (hubId: string) => string | null;
  /** The item's secret (same-token dedupe of a pasted kind). */
  secret: string;
  /** Owner key of a hub login's stored secret ({@link credentialOwnerKey}); null when unknown. */
  ownerKeyOf?: (hubId: string) => string | null;
  /** Owner key of the item's login. */
  itemOwnerKey?: string | null;
}): ImportTarget {
  const { item, rows, imports } = o;
  const key = (m: { agent: string; machine: string; localId: string }) =>
    m.agent === item.agent && m.machine === item.machine && m.localId === item.id;
  if (!item.force && imports.removed.some(key)) return { to: 'removed' };
  const named = rows.filter((r) => r.agent === item.agent && !isDefaultAccount(r.id));
  const mapped = imports.imports.find(key);
  const itemKey = o.itemOwnerKey ?? null;
  const keyOf = (id: string): string | null => o.ownerKeyOf?.(id) ?? null;
  const keysDiffer = (id: string): boolean => {
    const k = keyOf(id);
    return k !== null && itemKey !== null && k !== itemKey;
  };
  if (mapped) {
    if (
      isDefaultAccount(mapped.hubId) &&
      item.kind === 'login' &&
      !keysDiffer(DEFAULT_ACCOUNT_ID)
    ) {
      return { to: 'existing', hubId: DEFAULT_ACCOUNT_ID, why: 'mapping' };
    }
    const row = named.find((r) => r.id === mapped.hubId);
    if (
      row &&
      row.kind === item.kind &&
      !identityConflict(row.identity, item.identity) &&
      !keysDiffer(row.id)
    ) {
      return { to: 'existing', hubId: row.id, why: 'mapping' };
    }
  }
  if (item.kind === 'login') {
    // The hub's own login first: a PC's named login of the subscription the
    // hub's default already runs on is that account, not a second holder.
    if (itemKey !== null && keyOf(DEFAULT_ACCOUNT_ID) === itemKey) {
      return { to: 'existing', hubId: DEFAULT_ACCOUNT_ID, why: 'identity' };
    }
    const same = named.find(
      (r) =>
        r.kind === 'login' &&
        ((itemKey !== null && keyOf(r.id) === itemKey) ||
          (sameIdentity(r.identity, item.identity) && !keysDiffer(r.id))),
    );
    if (same) return { to: 'existing', hubId: same.id, why: 'identity' };
  } else {
    const same = named.find((r) => r.kind === item.kind && o.pastedSecretOf(r.id) === o.secret);
    if (same) return { to: 'existing', hubId: same.id, why: 'same-token' };
  }
  const taken = new Set(named.map((r) => r.id));
  taken.add(DEFAULT_ACCOUNT_ID);
  const hubId = freeAccountId(item.id, taken);
  return hubId === item.id ? { to: 'new', hubId } : { to: 'new', hubId, renamedFrom: item.id };
}

/** The mapping list with `(agent, machine, localId)` pointing at `hubId`. Pure. */
export function withMapping(
  file: AccountImportsFile,
  m: Omit<AccountImportMapping, 'at'>,
  at: string,
): AccountImportsFile {
  const same = (x: { agent: string; machine: string; localId: string }) =>
    x.agent === m.agent && x.machine === m.machine && x.localId === m.localId;
  const prev = file.imports.find(same);
  // An unchanged mapping keeps its entry (and stamp), so a re-push writes nothing.
  const entry =
    prev && prev.hubId === m.hubId && prev.machineLabel === m.machineLabel ? prev : { ...m, at };
  return {
    ...file,
    version: 1,
    imports: [...file.imports.filter((x) => !same(x)), entry],
    removed: file.removed.filter((x) => !same(x)),
  };
}

/** Every mapping into `agent/hubId` becomes a tombstone. Pure. */
export function tombstoneAccount(
  file: AccountImportsFile,
  agent: string,
  hubId: string,
  at: string,
): { file: AccountImportsFile; dropped: AccountImportMapping[] } {
  const dropped = file.imports.filter((m) => m.agent === agent && m.hubId === hubId);
  return {
    dropped,
    file: {
      ...withSetter(file, agent, hubId, null),
      version: 1,
      imports: file.imports.filter((m) => !(m.agent === agent && m.hubId === hubId)),
      removed: [
        ...file.removed.filter(
          (t) =>
            !(
              t.agent === agent &&
              dropped.some((d) => d.machine === t.machine && d.localId === t.localId)
            ),
        ),
        ...dropped.map((d) => ({ agent, machine: d.machine, localId: d.localId, at })),
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Create-time resolution (pure + one effectful wrapper).

/**
 * The hub account a create's NAME means for `agent`: the requester's own name
 * for it (its mapping) first, then a hub account of that id. `default` is
 * itself. Undefined when the hub has no such account. Pure.
 */
export function resolveHubAccountName(o: {
  agent: string;
  name: string;
  rows: readonly LlmAccount[];
  imports: AccountImportsFile;
  requesterMachine?: string;
}): string | undefined {
  if (isDefaultAccount(o.name)) return DEFAULT_ACCOUNT_ID;
  if (o.requesterMachine) {
    const m = o.imports.imports.find(
      (x) => x.agent === o.agent && x.machine === o.requesterMachine && x.localId === o.name,
    );
    if (m && isDefaultAccount(m.hubId)) return DEFAULT_ACCOUNT_ID;
    if (m && o.rows.some((r) => r.agent === o.agent && r.id === m.hubId)) return m.hubId;
  }
  return o.rows.some((r) => r.agent === o.agent && r.id === o.name) ? o.name : undefined;
}

// ---------------------------------------------------------------------------
// Effects.

/** The custody slice the importer needs (the hub's own store). */
export interface ImportCustody {
  put(path: string, data: Buffer): Promise<unknown>;
  get(path: string): Promise<{ data: Buffer } | null>;
  list(prefix?: string): Promise<{ path: string }[]>;
  delete(path: string): Promise<boolean>;
}

export interface AccountImporterDeps {
  store?: AccountStoreOptions;
  /** The imports file (tests); default `~/.agentbox/account-imports.json`. */
  importsPath?: string;
  /** The hub's custody; null on a hub without one. */
  custody?: () => ImportCustody | null;
  /** This hub's machine id: the `<machine>` its own named logins sit under in custody. */
  machineId: () => string | undefined;
  /** Where the default login's backup lives (tests); default the spec's `hostBackup`. */
  defaultBackupPath?: (spec: AgentSyncSpec) => string | undefined;
  now?: () => number;
}

export interface AccountImporter {
  readImports(): Promise<AccountImportsFile>;
  /**
   * Set a pasted token on the hub itself: `write` runs in the importer's chain
   * (no import lands between), then the account is marked {@link SET_ON_HUB}
   * so no import replaces that token after it.
   */
  setOnHub<T>(agent: string, hubId: string, write: () => Promise<T>): Promise<T>;
  importItems(items: readonly AccountImportItem[]): Promise<ImportResult[]>;
  /**
   * A hub `rm`: run `remove` (the store removal), then tombstone the mappings
   * and drop every custody copy of the account, all in the importer's chain.
   */
  forgetAccount(agent: string, hubId: string, remove?: () => Promise<void>): Promise<void>;
}

/** One writer at a time in this process (the hub is one process). */
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${String(process.pid)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

/** Why an item cannot be imported at all, or null. Pure apart from the registry. */
export function importItemProblem(item: unknown, specs = AGENT_SYNC_SPECS): string | null {
  const i = (item ?? {}) as Partial<AccountImportItem>;
  if (typeof i.agent !== 'string' || typeof i.id !== 'string') return 'agent and id are required';
  const spec = specs.find((s) => s.id === i.agent);
  if (!spec?.credential) return `unknown agent '${i.agent}', or one without a credential`;
  if (accountIdProblem(i.id)) return accountIdProblem(i.id);
  if (i.kind !== 'login' && i.kind !== 'setup-token' && i.kind !== 'api-key') {
    return 'kind must be login, setup-token or api-key';
  }
  if (isDefaultAccount(i.id) && i.kind !== 'login') return 'the default account is a login';
  if (!isDefaultAccount(i.id) && !agentAccountKinds(spec).includes(i.kind)) {
    return `${spec.id} cannot hold a ${i.kind} account`;
  }
  if (typeof i.secret !== 'string' || i.secret.length === 0) return 'secret is required';
  if (i.kind === 'login' && !isRealAgentCredential(spec.id, i.secret)) {
    return `not a usable ${spec.id} login`;
  }
  if (i.kind !== 'login' && decodePastedSecret(i.secret)?.kind !== i.kind) {
    return `a ${i.kind} secret must be its {kind, token} encoding`;
  }
  if (typeof i.machine !== 'string' || i.machine.length === 0) return 'machine is required';
  if (i.machine.includes('/') || i.machine.includes('..')) return 'machine is not a machine id';
  return null;
}

export function createAccountImporter(deps: AccountImporterDeps): AccountImporter {
  const store = deps.store;
  const importsPath = deps.importsPath ?? accountImportsPath(store?.stateDir ?? STATE_DIR);
  const now = deps.now ?? Date.now;
  const custody = (): ImportCustody | null => deps.custody?.() ?? null;
  const specs = store?.specs ?? AGENT_SYNC_SPECS;
  const specOf = (agent: string): AgentSyncSpec | undefined =>
    specs.find((s) => s.id === agent) ?? findAgentSpec(agent);

  /**
   * Absent reads as empty; anything else unreadable THROWS. Reading it as empty
   * would let the next import write that back, losing every mapping (suffixed
   * names stop resolving) and every tombstone (removed accounts come back).
   */
  async function readImports(): Promise<AccountImportsFile> {
    let text: string;
    try {
      text = await readFile(importsPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return parseImportsFile(null);
      throw err;
    }
    try {
      JSON.parse(text);
    } catch {
      throw new Error(
        `${importsPath} is not valid JSON; move it aside (imports then start over) or fix it`,
      );
    }
    return parseImportsFile(text);
  }

  /** Delete the dead copies a PC pushed before Phase 9 (never read again). Best-effort. */
  async function dropLegacyCopies(
    c: ImportCustody,
    spec: AgentSyncSpec,
    machine: string,
    localId: string,
    canonical: string | undefined,
    swept: Set<string>,
  ): Promise<void> {
    const file = spec.credential!.boxRelPath;
    const base = `agents/${spec.id}/${ACCOUNTS_CUSTODY_SEGMENT}`;
    const perPc = `${base}/${machine}/${localId}/${file}`;
    if (perPc !== canonical) await c.delete(perPc).catch(() => false);
    // Phase 4 flat objects: agents/<a>/accounts/<id>/<file> (five segments),
    // swept once per agent per batch.
    if (swept.has(spec.id)) return;
    swept.add(spec.id);
    for (const e of await c.list(`${base}/`).catch(() => [])) {
      const parts = e.path.split('/');
      if (parts.length === 5 && parts[4] === file) await c.delete(e.path).catch(() => false);
    }
  }

  /**
   * A named login over the hub's copy, gated by {@link importLoginVerdict}
   * under the credential's own lock (shared with the relay's fan-out).
   */
  async function importNamedLogin(
    spec: AgentSyncSpec,
    hubId: string,
    secret: string,
  ): Promise<{ written: boolean; reason: string }> {
    const path = accountSecretPath(spec, hubId, store?.stateDir ?? STATE_DIR)!;
    return withFileLock(path, async () => {
      const existing = await readAccountSecret(spec.id, hubId, store);
      const v = importLoginVerdict(spec, secret, existing);
      if (!v.accept) return { written: false, reason: v.reason };
      const w = await writeAccountSecret(spec.id, hubId, secret, store);
      return { written: w.written, reason: w.reason };
    });
  }

  async function importDefault(
    item: AccountImportItem,
    spec: AgentSyncSpec,
  ): Promise<ImportResult> {
    const backupPath = deps.defaultBackupPath?.(spec) ?? spec.credential!.hostBackup;
    // Read, gate and write under the credential's own lock, the one the relay's
    // fan-out takes for a box's refresh: an import must not land a revoked
    // token over a rotation that happened between its read and its write.
    // Expiry only (no identity gate): a PC that signed its default into
    // another subscription replaces it, as the custody push always did.
    const v = await withFileLock(backupPath, async () => {
      const existing = await readCredentialBackup(spec.id, { backupPath });
      const verdict = importLoginVerdict(spec, item.secret, existing);
      if (verdict.accept) await writeCredentialBackup(spec.id, item.secret, { backupPath });
      return verdict;
    });
    const result: ImportResult = {
      agent: spec.id,
      id: item.id,
      hubId: DEFAULT_ACCOUNT_ID,
      action: v.accept ? 'updated' : 'kept',
      reason: v.reason,
    };
    if (!v.accept) return result;
    await custody()
      ?.put(
        accountCustodyPath(spec.id, DEFAULT_ACCOUNT_ID, spec.credential!.boxRelPath),
        Buffer.from(item.secret, 'utf8'),
      )
      .catch(() => undefined);
    return result;
  }

  async function importNamed(
    item: AccountImportItem,
    spec: AgentSyncSpec,
    imports: AccountImportsFile,
    swept: Set<string>,
  ): Promise<{ result: ImportResult; imports: AccountImportsFile }> {
    const file = await readAccounts(store);
    const rows = file.accounts.filter((a) => a.agent === spec.id);
    const pasted = new Map<string, string | null>();
    const owners = new Map<string, string | null>();
    for (const r of rows) {
      if (isDefaultAccount(r.id)) continue;
      const secret = await readAccountSecret(spec.id, r.id, store);
      if (r.kind === 'login') owners.set(r.id, credentialOwnerKey(spec, secret));
      else pasted.set(r.id, secret);
    }
    const defaultBackup = deps.defaultBackupPath?.(spec);
    owners.set(
      DEFAULT_ACCOUNT_ID,
      credentialOwnerKey(
        spec,
        await readCredentialBackup(spec.id, defaultBackup ? { backupPath: defaultBackup } : {}),
      ),
    );
    const target = planAccountImport({
      item,
      rows,
      imports,
      pastedSecretOf: (id) => pasted.get(id) ?? null,
      secret: item.secret,
      ownerKeyOf: (id) => owners.get(id) ?? null,
      itemOwnerKey: item.kind === 'login' ? credentialOwnerKey(spec, item.secret) : null,
    });
    if (target.to === 'removed') {
      return {
        imports,
        result: {
          agent: spec.id,
          id: item.id,
          action: 'removed',
          reason: 'removed on the hub; `agentbox hub credentials push --force` brings it back',
        },
      };
    }
    const at = new Date(now()).toISOString();
    let action: ImportAction;
    let reason: string;
    if (target.to === 'existing' && isDefaultAccount(target.hubId)) {
      // The hub's own login is this subscription: the PC's named copy feeds it.
      const d = await importDefault({ ...item, id: DEFAULT_ACCOUNT_ID }, spec);
      // A first match by identity is news even when the hub's copy wins.
      action = target.why === 'mapping' ? (d.action === 'updated' ? 'updated' : 'kept') : 'merged';
      reason = d.action === 'updated' ? `took this PC's newer login` : `the hub's copy is current`;
    } else if (target.to === 'new') {
      await upsertAccount(
        {
          agent: spec.id,
          id: target.hubId,
          kind: item.kind,
          ...(item.identity ? { identity: item.identity } : {}),
          createdAt: at,
        },
        store,
      );
      try {
        await writeAccountSecret(spec.id, target.hubId, item.secret, store);
      } catch (err) {
        await removeStoredAccount(spec.id, target.hubId, store).catch(() => {});
        throw err;
      }
      action = target.renamedFrom ? 'renamed' : 'created';
      reason = target.renamedFrom
        ? `the hub already has a ${spec.id}/${target.renamedFrom} of another subscription`
        : 'new on the hub';
    } else {
      const row = findAccount(file, spec.id, target.hubId)!;
      // Keep what the hub knows of the identity, and fill what it lacks.
      if (item.identity && !sameIdentityFields(row.identity, item.identity)) {
        await upsertAccount(
          { ...row, identity: { ...item.identity, ...stripUndefined(row.identity) } },
          store,
        );
      }
      if (item.kind === 'login') {
        const w = await importNamedLogin(spec, target.hubId, item.secret);
        action = target.why === 'mapping' ? (w.written ? 'updated' : 'kept') : 'merged';
        reason = w.written
          ? `took this PC's newer login (${w.reason})`
          : `the hub's copy is current`;
      } else if ((pasted.get(target.hubId) ?? null) === item.secret) {
        action = target.why === 'mapping' ? 'kept' : 'merged';
        reason = 'same token';
      } else if (
        mayReplacePasted(imports, spec.id, target.hubId, item.machine, target.why === 'mapping')
      ) {
        await writeAccountSecret(spec.id, target.hubId, item.secret, store);
        action = 'updated';
        reason = 'new token';
      } else {
        // Another machine (or the hub itself) set the current token: this PC's
        // copy is not newer just because it differs.
        action = 'kept';
        reason = `the hub's token was set elsewhere; to change it, replace it on the hub (\`agentbox credentials add ${spec.id}/${target.hubId} --replace\` with this hub configured, or its Subscriptions page)`;
      }
    }
    const mapped = withMapping(
      imports,
      {
        agent: spec.id,
        machine: item.machine,
        localId: item.id,
        hubId: target.hubId,
        ...(item.machineLabel ? { machineLabel: item.machineLabel } : {}),
      },
      at,
    );
    const next =
      item.kind !== 'login' &&
      (action === 'created' || action === 'renamed' || action === 'updated')
        ? withSetter(mapped, spec.id, target.hubId, item.machine)
        : mapped;
    const c = custody();
    if (c) {
      const hubMachine = deps.machineId();
      const canonical = isDefaultAccount(target.hubId)
        ? accountCustodyPath(spec.id, DEFAULT_ACCOUNT_ID, spec.credential!.boxRelPath)
        : item.kind === 'login' && hubMachine
          ? accountCustodyPath(spec.id, target.hubId, spec.credential!.boxRelPath, hubMachine)
          : undefined;
      if (canonical && !isDefaultAccount(target.hubId)) {
        // The store's copy, which is the newest of the two after the gate.
        const live = await readAccountSecret(spec.id, target.hubId, store);
        if (live) await c.put(canonical, Buffer.from(live, 'utf8')).catch(() => undefined);
      }
      await dropLegacyCopies(c, spec, item.machine, item.id, canonical, swept);
    }
    return {
      imports: next,
      result: { agent: spec.id, id: item.id, hubId: target.hubId, action, reason },
    };
  }

  return {
    readImports,
    setOnHub: <T>(agent: string, hubId: string, write: () => Promise<T>) =>
      serialized(async () => {
        const result = await write();
        const before = await readImports();
        const after = withSetter(before, agent, hubId, SET_ON_HUB);
        if (JSON.stringify(after) !== JSON.stringify(before)) {
          await writeJsonAtomic(importsPath, after);
        }
        return result;
      }),
    importItems: (items) =>
      serialized(async () => {
        const before = await readImports();
        let imports = before;
        const swept = new Set<string>();
        const results: ImportResult[] = [];
        for (const raw of items) {
          const problem = importItemProblem(raw, specs);
          const item = raw;
          if (problem) {
            results.push({
              agent: String((raw as { agent?: unknown })?.agent ?? ''),
              id: String((raw as { id?: unknown })?.id ?? ''),
              action: 'refused',
              reason: problem,
            });
            continue;
          }
          const spec = specOf(item.agent)!;
          try {
            if (isDefaultAccount(item.id)) {
              results.push(await importDefault(item, spec));
              continue;
            }
            const r = await importNamed(item, spec, imports, swept);
            imports = r.imports;
            results.push(r.result);
          } catch (err) {
            results.push({
              agent: spec.id,
              id: item.id,
              action: 'refused',
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (JSON.stringify(imports) !== JSON.stringify(before)) {
          await writeJsonAtomic(importsPath, imports);
        }
        return results;
      }),
    forgetAccount: (agent, hubId, remove) =>
      serialized(async () => {
        // The store removal runs in the same chain as imports, so an import
        // cannot write the secret or a mapping of an account being removed.
        if (remove) await remove();
        const { file, dropped } = tombstoneAccount(
          await readImports(),
          agent,
          hubId,
          new Date(now()).toISOString(),
        );
        if (dropped.length > 0) await writeJsonAtomic(importsPath, file);
        const c = custody();
        const spec = specOf(agent);
        if (!c || !spec?.credential) return;
        const name = spec.credential.boxRelPath;
        const base = `agents/${spec.id}/${ACCOUNTS_CUSTODY_SEGMENT}`;
        const paths = new Set<string>([`${base}/${hubId}/${name}`]);
        const hubMachine = deps.machineId();
        if (hubMachine) paths.add(`${base}/${hubMachine}/${hubId}/${name}`);
        for (const d of dropped) paths.add(`${base}/${d.machine}/${d.localId}/${name}`);
        for (const p of paths) await c.delete(p).catch(() => false);
      }),
  };
}

function stripUndefined(i?: LlmAccountIdentity): LlmAccountIdentity {
  const out: LlmAccountIdentity = {};
  for (const [k, v] of Object.entries(i ?? {})) {
    if (typeof v === 'string' && v.length > 0) (out as Record<string, string>)[k] = v;
  }
  return out;
}

function sameIdentityFields(a?: LlmAccountIdentity, b?: LlmAccountIdentity): boolean {
  const x = stripUndefined(a);
  const y = { ...stripUndefined(b), ...x };
  return JSON.stringify(Object.entries(x).sort()) === JSON.stringify(Object.entries(y).sort());
}

/**
 * The hub accounts a create runs on, resolved against THIS hub's store
 * (Phase 9 Selection): the client's name per agent (`names`, the requester's
 * own name allowed), else the hub's global `<agent>.account`, else `default`.
 * Throws the reason when an account is missing, has no secret, or is a pasted
 * kind where a borrowed login is needed: a create must never start a box on
 * an account it cannot seed. Returns the named accounts only.
 */
export async function resolveHubCreateAccounts(o: {
  agents: readonly string[];
  names?: Readonly<Record<string, string>>;
  loginOnly?: readonly string[];
  requesterMachine?: string;
  /** The hub's global `<agent>.account` per agent. */
  hubDefaults?: Readonly<Record<string, string | undefined>>;
  store?: AccountStoreOptions;
  imports?: AccountImportsFile;
  /**
   * The hub's own (default) login of an agent, or null: every source a create
   * seeds the default from that this hub can read (the backup, the agent's own
   * host login file). A box on `default` with none starts signed out, so that
   * is refused too. Absent: not checked.
   */
  defaultLogin?: (agent: string) => Promise<string | null>;
  /**
   * Set when a source the hub cannot read here may still hold the login (a
   * docker-shaped box falls back to the agent's config volume): no login
   * found is then this warning, not a refusal.
   */
  warnNoDefaultLogin?: (message: string) => void;
}): Promise<Record<string, string>> {
  const names = o.names ?? {};
  for (const agent of Object.keys(names)) {
    if (!o.agents.includes(agent)) {
      throw new Error(`account ${agent}=${names[agent]}: this box does not carry ${agent}`);
    }
  }
  const file = await readAccounts(o.store);
  const imports = o.imports ?? EMPTY_IMPORTS;
  const out: Record<string, string> = {};
  for (const agent of o.agents) {
    const spec = findAgentSpec(agent);
    if (!spec) continue;
    const sent = names[spec.id];
    const name = sent ?? o.hubDefaults?.[spec.id] ?? DEFAULT_ACCOUNT_ID;
    // The requester's own names apply only to a name it SENT: the hub's
    // default `work` is the hub's `work`, not that PC's `work` (filed `work_2`).
    const hubId = resolveHubAccountName({
      agent: spec.id,
      name,
      rows: file.accounts,
      imports,
      ...(sent !== undefined && o.requesterMachine ? { requesterMachine: o.requesterMachine } : {}),
    });
    if (hubId === undefined) {
      throw new Error(
        `no ${spec.id} account '${name}' on this hub: push it from the PC that signed it in (\`agentbox hub credentials push\`), or pick one from \`agentbox credentials\``,
      );
    }
    if (isDefaultAccount(hubId)) {
      if (o.defaultLogin && spec.credential && agentAccountKinds(spec).length > 0) {
        const text = await o.defaultLogin(spec.id);
        if (text === null || !isRealAgentCredential(spec.id, text)) {
          const message = `this hub has no ${spec.id} login (the default account), so a box on it would start signed out: push one (\`agentbox hub credentials push\`), or pick a named account`;
          if (!o.warnNoDefaultLogin) throw new Error(message);
          o.warnNoDefaultLogin(`${message} (unless the agent's config volume holds one)`);
        }
      }
      continue;
    }
    const row = findAccount(file, spec.id, hubId)!;
    if (o.loginOnly?.includes(spec.id) && row.kind !== 'login') {
      throw new Error(
        `${spec.id} account '${hubId}' is a ${row.kind}; a borrowed model-auth login needs a login account`,
      );
    }
    if ((await readAccountSecret(spec.id, hubId, o.store)) === null) {
      throw new Error(
        `${spec.id} account '${hubId}' has no stored login on this hub, so a box on it would start signed out: push it again (\`agentbox hub credentials push\`)`,
      );
    }
    out[spec.id] = hubId;
  }
  return out;
}
