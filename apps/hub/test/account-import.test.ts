import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// Scratch HOME before the imports: STATE_DIR (the store, the default login's
// backup, the imports file) is computed from it at module load.
const home = mkdtempSync(join(tmpdir(), 'agentbox-acct-import-'));
const realHome = process.env.HOME;
process.env.HOME = home;
const mod = await import('../lib/backend/account-import');
const core = await import('@agentbox/sandbox-core');
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

const {
  createAccountImporter,
  credentialOwnerKey,
  freeAccountId,
  importLoginVerdict,
  planAccountImport,
  tombstoneAccount,
  resolveHubAccountName,
  resolveHubCreateAccounts,
  EMPTY_IMPORTS,
} = mod;

/** A fake claude login: owner = accountUuid, freshness = expiresAt. Never a real token. */
const login = (owner: string, expiresAt: number, rt = 'r') =>
  JSON.stringify({
    claudeAiOauth: {
      refreshToken: `${rt}-${owner}`,
      expiresAt,
      accountUuid: owner,
      organizationUuid: 'org-1',
    },
  });

/** A fake codex auth.json: no freshness field, ordered by the access token's JWT `exp`. */
const codexAuth = (exp: number, tag = 'x', account = 'acct-1') => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return JSON.stringify({
    tokens: {
      access_token: `${b64({ alg: 'none' })}.${b64({ exp })}.sig`,
      refresh_token: `fake-rt-${tag}`,
      account_id: account,
    },
  });
};

const PC_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const PC_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const HUB = 'hhhhhhhh-0000-0000-0000-000000000009';

function fakeCustody() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    put: (p: string, d: Buffer) => {
      objects.set(p, d);
      return Promise.resolve({});
    },
    get: (p: string) => Promise.resolve(objects.has(p) ? { data: objects.get(p)! } : null),
    list: (prefix?: string) =>
      Promise.resolve(
        [...objects.keys()]
          .filter((p) => !prefix || p.startsWith(prefix))
          .map((path) => ({ path })),
      ),
    delete: (p: string) => Promise.resolve(objects.delete(p)),
  };
}

const row = (id: string, extra: Partial<import('@agentbox/core').LlmAccount> = {}) => ({
  agent: 'claude',
  id,
  kind: 'login' as const,
  createdAt: 't',
  ...extra,
});

describe('planAccountImport (pure)', () => {
  const base = {
    imports: EMPTY_IMPORTS,
    pastedSecretOf: () => null,
    secret: 'x',
  };

  it('a new id lands as itself', () => {
    expect(
      planAccountImport({
        ...base,
        item: { agent: 'claude', id: 'second', kind: 'login', machine: PC_A },
        rows: [],
      }),
    ).toEqual({ to: 'new', hubId: 'second' });
  });

  it('merges two PCs signed in to one subscription (same owner key, or same email)', () => {
    const rows = [row('work')];
    expect(
      planAccountImport({
        ...base,
        item: { agent: 'claude', id: 'job', kind: 'login', machine: PC_B },
        rows,
        ownerKeyOf: (id) => (id === 'work' ? 'u1/org-1' : null),
        itemOwnerKey: 'u1/org-1',
      }),
    ).toEqual({ to: 'existing', hubId: 'work', why: 'identity' });
    expect(
      planAccountImport({
        ...base,
        item: {
          agent: 'claude',
          id: 'job',
          kind: 'login',
          machine: PC_B,
          identity: { email: 'A@x.io' },
        },
        rows: [row('work', { identity: { email: 'a@x.io' } })],
      }),
    ).toEqual({ to: 'existing', hubId: 'work', why: 'identity' });
  });

  it("maps a named login onto the hub's default when it is the same subscription", () => {
    expect(
      planAccountImport({
        ...base,
        item: { agent: 'claude', id: 'second', kind: 'login', machine: PC_A },
        rows: [],
        ownerKeyOf: (id) => (id === 'default' ? 'u9/org-1' : null),
        itemOwnerKey: 'u9/org-1',
      }),
    ).toEqual({ to: 'existing', hubId: 'default', why: 'identity' });
  });

  it('suffixes the same id of another (or unknown) subscription, never overwrites', () => {
    expect(
      planAccountImport({
        ...base,
        item: { agent: 'claude', id: 'second', kind: 'login', machine: PC_B },
        rows: [row('second')],
        ownerKeyOf: (id) => (id === 'second' ? 'u1/org-1' : null),
        itemOwnerKey: 'u2/org-1',
      }),
    ).toEqual({ to: 'new', hubId: 'second_2', renamedFrom: 'second' });
    expect(
      planAccountImport({
        ...base,
        item: { agent: 'claude', id: 'second', kind: 'login', machine: PC_B },
        rows: [row('second')],
      }),
    ).toEqual({ to: 'new', hubId: 'second_2', renamedFrom: 'second' });
  });

  it("follows the item's own mapping, unless the PC re-signed it into another subscription", () => {
    const imports = {
      version: 1 as const,
      imports: [{ agent: 'claude', machine: PC_B, localId: 'second', hubId: 'second_2', at: 't' }],
      removed: [],
    };
    const item = { agent: 'claude', id: 'second', kind: 'login' as const, machine: PC_B };
    const rows = [row('second'), row('second_2')];
    expect(planAccountImport({ ...base, imports, item, rows })).toEqual({
      to: 'existing',
      hubId: 'second_2',
      why: 'mapping',
    });
    expect(
      planAccountImport({
        ...base,
        imports,
        item,
        rows,
        ownerKeyOf: () => 'u1/org-1',
        itemOwnerKey: 'u3/org-1',
      }),
    ).toEqual({ to: 'new', hubId: 'second_3', renamedFrom: 'second' });
  });

  it('a pasted kind merges only on the same token', () => {
    const rows = [row('ci', { kind: 'setup-token' })];
    const item = { agent: 'claude', id: 'tok', kind: 'setup-token' as const, machine: PC_A };
    expect(
      planAccountImport({ ...base, item, rows, pastedSecretOf: () => 'S', secret: 'S' }),
    ).toEqual({ to: 'existing', hubId: 'ci', why: 'same-token' });
    expect(
      planAccountImport({ ...base, item, rows, pastedSecretOf: () => 'S', secret: 'T' }),
    ).toEqual({ to: 'new', hubId: 'tok' });
  });

  it('a mapping removed on the hub stays removed unless forced', () => {
    const imports = {
      version: 1 as const,
      imports: [],
      removed: [{ agent: 'claude', machine: PC_A, localId: 'second', at: 't' }],
    };
    const item = { agent: 'claude', id: 'second', kind: 'login' as const, machine: PC_A };
    expect(planAccountImport({ ...base, imports, item, rows: [] })).toEqual({ to: 'removed' });
    expect(
      planAccountImport({ ...base, imports, item: { ...item, force: true }, rows: [] }),
    ).toEqual({ to: 'new', hubId: 'second' });
  });
});

describe('tombstoneAccount (review: one agent never clears another)', () => {
  it("keeps claude's tombstone when codex's account of the same PC name is removed", () => {
    const start = {
      version: 1 as const,
      imports: [{ agent: 'codex', machine: PC_A, localId: 'work', hubId: 'work', at: 't' }],
      removed: [{ agent: 'claude', machine: PC_A, localId: 'work', at: 't' }],
    };
    const { file } = tombstoneAccount(start, 'codex', 'work', 't2');
    expect(file.removed.map((t) => t.agent).sort()).toEqual(['claude', 'codex']);
  });
});

describe('importLoginVerdict (#528 review: codex is ordered by its JWT exp)', () => {
  const codex = core.AGENT_SYNC_SPECS.find((s) => s.id === 'codex')!;
  it("never takes a PC's older codex copy because it merely differs", () => {
    expect(importLoginVerdict(codex, codexAuth(100, 'old'), codexAuth(200, 'new')).accept).toBe(
      false,
    );
    expect(importLoginVerdict(codex, codexAuth(300, 'newer'), codexAuth(200, 'new')).accept).toBe(
      true,
    );
    expect(importLoginVerdict(codex, codexAuth(1), null).accept).toBe(true);
  });
});

describe('freeAccountId / credentialOwnerKey / resolveHubAccountName (pure)', () => {
  it('cuts the base to fit 32 characters', () => {
    const long = 'a'.repeat(32);
    const id = freeAccountId(long, new Set([long]));
    expect(id).toBe(`${'a'.repeat(30)}_2`);
    expect(freeAccountId('w', new Set(['w', 'w_2']))).toBe('w_3');
  });

  it('reads the owner off the login, null when a path is missing', () => {
    const spec = core.AGENT_SYNC_SPECS.find((s) => s.id === 'claude');
    expect(credentialOwnerKey(spec, login('u1', 5))).toBe('u1/org-1');
    expect(
      credentialOwnerKey(spec, JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } })),
    ).toBeNull();
  });

  it("resolves the requester's own name first, then the hub id", () => {
    const imports = {
      version: 1 as const,
      imports: [
        { agent: 'claude', machine: PC_B, localId: 'second', hubId: 'second_2', at: 't' },
        { agent: 'claude', machine: PC_A, localId: 'mine', hubId: 'default', at: 't' },
      ],
      removed: [],
    };
    const rows = [row('second'), row('second_2')];
    const r = (name: string, requesterMachine?: string) =>
      resolveHubAccountName({
        agent: 'claude',
        name,
        rows,
        imports,
        ...(requesterMachine ? { requesterMachine } : {}),
      });
    expect(r('second', PC_B)).toBe('second_2');
    expect(r('second', PC_A)).toBe('second');
    expect(r('second')).toBe('second');
    expect(r('mine', PC_A)).toBe('default');
    expect(r('nope', PC_A)).toBeUndefined();
  });
});

describe('the importer (store + custody effects)', () => {
  let n = 0;
  let stateDir: string;
  let custody: ReturnType<typeof fakeCustody>;
  let importer: ReturnType<typeof createAccountImporter>;
  const store = () => ({ path: join(stateDir, 'accounts.json'), stateDir });
  const defaultBackup = () => join(stateDir, 'claude-credentials.json');

  beforeEach(() => {
    stateDir = join(home, `run-${String(++n)}`);
    custody = fakeCustody();
    importer = createAccountImporter({
      store: store(),
      importsPath: join(stateDir, 'account-imports.json'),
      custody: () => custody,
      machineId: () => HUB,
      defaultBackupPath: () => defaultBackup(),
    });
  });

  const item = (machine: string, id: string, secret: string, extra = {}) => ({
    agent: 'claude',
    id,
    kind: 'login' as const,
    secret,
    machine,
    ...extra,
  });

  it('imports, dedupes a second PC, suffixes a collision, and keeps the newest login', async () => {
    const [created] = await importer.importItems([item(PC_A, 'second', login('u1', 100))]);
    expect(created).toMatchObject({ action: 'created', hubId: 'second' });
    expect(custody.objects.has(`agents/claude/accounts/${HUB}/second/.credentials.json`)).toBe(
      true,
    );

    // Same subscription from PC B under another name: one hub account.
    const [merged] = await importer.importItems([item(PC_B, 'job', login('u1', 200, 'r2'))]);
    expect(merged).toMatchObject({ action: 'merged', hubId: 'second' });
    // Another subscription under the same id from PC B: suffixed.
    const [renamed] = await importer.importItems([item(PC_B, 'second', login('u2', 50))]);
    expect(renamed).toMatchObject({ action: 'renamed', hubId: 'second_2' });

    // PC A re-pushes its now-older copy (a hub box refreshed it): the hub keeps its own.
    const [kept] = await importer.importItems([item(PC_A, 'second', login('u1', 100))]);
    expect(kept).toMatchObject({ action: 'kept', hubId: 'second' });
    expect(
      JSON.parse((await core.readAccountSecret('claude', 'second', store()))!).claudeAiOauth
        .expiresAt,
    ).toBe(200);

    const imports = await importer.readImports();
    expect(imports.imports.map((m) => `${m.machine}:${m.localId}->${m.hubId}`).sort()).toEqual(
      [`${PC_A}:second->second`, `${PC_B}:job->second`, `${PC_B}:second->second_2`].sort(),
    );
    // The create resolves each PC's own name.
    expect(
      await resolveHubCreateAccounts({
        agents: ['claude'],
        names: { claude: 'second' },
        requesterMachine: PC_B,
        store: store(),
        imports,
      }),
    ).toEqual({ claude: 'second_2' });
  });

  it("feeds the hub's default when a PC's named login is that subscription", async () => {
    await core.writeCredentialBackup('claude', login('u9', 100), { backupPath: defaultBackup() });
    const [r] = await importer.importItems([item(PC_A, 'second', login('u9', 300))]);
    expect(r).toMatchObject({ action: 'merged', hubId: 'default' });
    expect(JSON.parse(await readFile(defaultBackup(), 'utf8')).claudeAiOauth.expiresAt).toBe(300);
    expect(custody.objects.has('agents/claude/.credentials.json')).toBe(true);
    expect((await core.readAccounts(store())).accounts.some((a) => a.id === 'second')).toBe(false);
    expect(
      await resolveHubCreateAccounts({
        agents: ['claude'],
        names: { claude: 'second' },
        requesterMachine: PC_A,
        store: store(),
        imports: await importer.readImports(),
      }),
    ).toEqual({});
  });

  it('drops the dead per-PC and flat custody copies on import', async () => {
    custody.objects.set(
      `agents/claude/accounts/${PC_A}/second/.credentials.json`,
      Buffer.from('x'),
    );
    custody.objects.set('agents/claude/accounts/second/.credentials.json', Buffer.from('x'));
    await importer.importItems([item(PC_A, 'second', login('u1', 100))]);
    expect([...custody.objects.keys()]).toEqual([
      `agents/claude/accounts/${HUB}/second/.credentials.json`,
    ]);
  });

  it('forgetAccount tombstones the mapping and removes every custody copy', async () => {
    await importer.importItems([item(PC_A, 'second', login('u1', 100))]);
    await importer.forgetAccount('claude', 'second', async () => {
      await core.removeAccount('claude', 'second', store());
    });
    expect(custody.objects.size).toBe(0);
    const [again] = await importer.importItems([item(PC_A, 'second', login('u1', 400))]);
    expect(again!.action).toBe('removed');
    const [forced] = await importer.importItems([
      item(PC_A, 'second', login('u1', 400), { force: true }),
    ]);
    expect(forced).toMatchObject({ action: 'created', hubId: 'second' });
  });

  it('carries a setup token (static, safe for many holders) into the store', async () => {
    const secret = core.encodePastedSecret({
      kind: 'setup-token',
      token: 'sk-ant-oat01-' + 'z'.repeat(30),
    });
    const [r] = await importer.importItems([
      { agent: 'claude', id: 'ci', kind: 'setup-token', secret, machine: PC_A },
    ]);
    expect(r).toMatchObject({ action: 'created', hubId: 'ci' });
    // Never mirrored to custody: no box posts it back.
    expect(custody.objects.size).toBe(0);
  });

  it('refuses a malformed item without touching the rest', async () => {
    const results = await importer.importItems([
      item(PC_A, 'bad', 'not json'),
      item(PC_A, 'good', login('u5', 1)),
    ]);
    expect(results.map((r) => r.action)).toEqual(['refused', 'created']);
  });

  it('refuses to import over a corrupt imports file instead of wiping it', async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'account-imports.json'), '{ truncated');
    await expect(importer.importItems([item(PC_A, 'second', login('u1', 1))])).rejects.toThrow(
      /not valid JSON/,
    );
    expect(await readFile(join(stateDir, 'account-imports.json'), 'utf8')).toBe('{ truncated');
  });

  it('a re-push that changes nothing does not rewrite the imports file', async () => {
    await importer.importItems([item(PC_A, 'second', login('u1', 100))]);
    const path = join(stateDir, 'account-imports.json');
    const before = (await stat(path)).mtimeMs;
    const text = await readFile(path, 'utf8');
    await new Promise((r) => setTimeout(r, 20));
    const [r] = await importer.importItems([item(PC_A, 'second', login('u1', 100))]);
    expect(r!.action).toBe('kept');
    expect((await stat(path)).mtimeMs).toBe(before);
    expect(await readFile(path, 'utf8')).toBe(text);
  });

  it("keeps the hub's refreshed codex login over a PC's stale default and named copies", async () => {
    const codexBackup = join(stateDir, 'codex-credentials.json');
    const imp = createAccountImporter({
      store: store(),
      importsPath: join(stateDir, 'account-imports.json'),
      custody: () => custody,
      machineId: () => HUB,
      defaultBackupPath: (spec) => (spec.id === 'codex' ? codexBackup : defaultBackup()),
    });
    await mkdir(stateDir, { recursive: true });
    await core.writeCredentialBackup('codex', codexAuth(500, 'hub'), { backupPath: codexBackup });
    const [d] = await imp.importItems([
      { agent: 'codex', id: 'default', kind: 'login', secret: codexAuth(100, 'pc'), machine: PC_A },
    ]);
    expect(d!.action).toBe('kept');
    expect(await readFile(codexBackup, 'utf8')).toBe(codexAuth(500, 'hub'));

    const [first] = await imp.importItems([
      {
        agent: 'codex',
        id: 'work',
        kind: 'login',
        secret: codexAuth(100, 'pc', 'acct-2'),
        machine: PC_A,
      },
    ]);
    expect(first).toMatchObject({ action: 'created' });
    // A hub box refreshes it...
    await core.writeAccountSecret('codex', 'work', codexAuth(900, 'hub', 'acct-2'), store());
    // ...and the PC re-pushes its now-dead copy.
    const [n] = await imp.importItems([
      {
        agent: 'codex',
        id: 'work',
        kind: 'login',
        secret: codexAuth(100, 'pc', 'acct-2'),
        machine: PC_A,
      },
    ]);
    expect(n!.action).toBe('kept');
    expect(await core.readAccountSecret('codex', 'work', store())).toBe(
      codexAuth(900, 'hub', 'acct-2'),
    );
  });

  it('waits for the credential lock the relay holds, then gates on what it wrote', async () => {
    await mkdir(stateDir, { recursive: true });
    await core.writeCredentialBackup('claude', login('u9', 100), { backupPath: defaultBackup() });
    const { withFileLock } = await import('@agentbox/config');
    let release!: () => void;
    const held = withFileLock(defaultBackup(), async () => {
      await new Promise<void>((r) => (release = r));
      // The relay's fan-out lands a rotation while holding the lock.
      await core.writeCredentialBackup('claude', login('u9', 999), {
        backupPath: defaultBackup(),
      });
    });
    await new Promise((r) => setTimeout(r, 20));
    const pending = importer.importItems([item(PC_A, 'default', login('u9', 500))]);
    await new Promise((r) => setTimeout(r, 50));
    release();
    await held;
    const [r] = await pending;
    expect(r!.action).toBe('kept');
    expect(JSON.parse(await readFile(defaultBackup(), 'utf8')).claudeAiOauth.expiresAt).toBe(999);
  });

  it('a shared key is replaced only by the machine that set it (#528 review)', async () => {
    const tok = (t: string) =>
      core.encodePastedSecret({ kind: 'setup-token', token: 'sk-ant-oat01-' + t.repeat(30) });
    const pasted = (machine: string, t: string) => ({
      agent: 'claude',
      id: 'ci',
      kind: 'setup-token' as const,
      secret: tok(t),
      machine,
    });
    expect((await importer.importItems([pasted(PC_A, 'a')]))[0]!.action).toBe('created');
    expect((await importer.importItems([pasted(PC_B, 'a')]))[0]).toMatchObject({
      action: 'merged',
      hubId: 'ci',
    });
    // A rotates its key: it set the token, so it may.
    expect((await importer.importItems([pasted(PC_A, 'b')]))[0]!.action).toBe('updated');
    // B's next automatic push still carries the old one: kept, never flipped back.
    expect((await importer.importItems([pasted(PC_B, 'a')]))[0]!.action).toBe('kept');
    expect(await core.readAccountSecret('claude', 'ci', store())).toBe(tok('b'));
    // Replaced on the hub itself: no machine's import replaces it after that.
    await importer.clearSetter('claude', 'ci');
    expect((await importer.importItems([pasted(PC_A, 'c')]))[0]!.action).toBe('kept');
  });

  it("the hub's default name is the hub's own, never the requester's mapping (#528 review)", async () => {
    await importer.importItems([item(PC_A, 'work', login('u1', 1))]);
    await importer.importItems([item(PC_B, 'work', login('u2', 1))]); // -> work_2
    const imports = await importer.readImports();
    const base = { agents: ['claude'], requesterMachine: PC_B, store: store(), imports };
    expect(await resolveHubCreateAccounts({ ...base, hubDefaults: { claude: 'work' } })).toEqual({
      claude: 'work',
    });
    expect(await resolveHubCreateAccounts({ ...base, names: { claude: 'work' } })).toEqual({
      claude: 'work_2',
    });
  });

  it('refuses a box on default when the hub holds no default login', async () => {
    await expect(
      resolveHubCreateAccounts({
        agents: ['claude'],
        store: store(),
        defaultLogin: () => Promise.resolve(null),
      }),
    ).rejects.toThrow(/no claude login \(the default account\)/);
    expect(
      await resolveHubCreateAccounts({
        agents: ['claude'],
        store: store(),
        defaultLogin: () => Promise.resolve(login('u1', 1)),
      }),
    ).toEqual({});
  });

  it('a create never starts on an account the hub cannot seed', async () => {
    await expect(
      resolveHubCreateAccounts({ agents: ['claude'], names: { claude: 'nope' }, store: store() }),
    ).rejects.toThrow(/no claude account 'nope' on this hub/);
    await core.upsertAccount(row('empty'), store());
    await expect(
      resolveHubCreateAccounts({ agents: ['claude'], names: { claude: 'empty' }, store: store() }),
    ).rejects.toThrow(/no stored login on this hub/);
    // No name sent: the hub's own global default applies.
    await importer.importItems([item(PC_A, 'work', login('u7', 1))]);
    expect(
      await resolveHubCreateAccounts({
        agents: ['claude'],
        hubDefaults: { claude: 'work' },
        store: store(),
      }),
    ).toEqual({ claude: 'work' });
  });
});
