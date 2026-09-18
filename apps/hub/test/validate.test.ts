import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseCheckpointCreate,
  parseCloneBox,
  parseCreateBox,
  parseHostUpsert,
  parseProject,
  parsePrune,
  parseManagerDetect,
  parseManagerMessage,
  parseManagerStart,
  parseTaskAssign,
  parseTaskCreate,
  parseTaskReorder,
  parseTaskUpdate,
  parseTimelineQuery,
  parseWorkspaceAdd,
} from '../app/(dashboard)/api/v1/lib/validate';

describe('parseProject', () => {
  it('accepts { path } as a register request', () => {
    const r = parseProject({ path: '/Users/me/app' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ kind: 'register', path: '/Users/me/app' });
  });

  it('accepts { parent, name } as a create request, git defaulting to false', () => {
    const r = parseProject({ parent: '/Users/me', name: 'my-bot' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ kind: 'create', parent: '/Users/me', name: 'my-bot', git: false });
  });

  it('carries git: true', () => {
    const r = parseProject({ parent: '/Users/me', name: 'app', git: true });
    expect(r.ok && r.value.kind === 'create' && r.value.git).toBe(true);
  });

  it('rejects BOTH path and parent/name (ambiguous)', () => {
    expect(parseProject({ path: '/a', parent: '/b', name: 'c' }).ok).toBe(false);
    expect(parseProject({ path: '/a', git: true }).ok).toBe(false);
  });

  it('rejects neither', () => {
    expect(parseProject({}).ok).toBe(false);
    expect(parseProject({ path: '' }).ok).toBe(false);
  });

  it('rejects a create with no parent', () => {
    expect(parseProject({ name: 'x' }).ok).toBe(false);
  });

  it('rejects names that are not a single plain folder name', () => {
    for (const name of ['', '.', '..', '.hidden', 'a/b', 'a\\b', ' x', 'a'.repeat(101)]) {
      expect(parseProject({ parent: '/p', name }).ok, JSON.stringify(name)).toBe(false);
    }
    for (const name of ['a', 'my-bot', 'v1.2_rc', 'A'.repeat(100)]) {
      expect(parseProject({ parent: '/p', name }).ok, name).toBe(true);
    }
  });

  it('rejects a non-boolean git', () => {
    expect(parseProject({ parent: '/p', name: 'x', git: 'yes' }).ok).toBe(false);
  });
});

describe('parseCreateBox', () => {
  it('accepts a projectId (local file-queue path)', () => {
    const r = parseCreateBox({ projectId: 'abc123', agent: 'none' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.projectId).toBe('abc123');
    expect(r.value.repoUrl).toBeUndefined();
  });

  it('accepts a repoUrl (control-plane clone path) with no projectId', () => {
    const r = parseCreateBox({ repoUrl: 'https://github.com/acme/w.git', agent: 'claude' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.repoUrl).toBe('https://github.com/acme/w.git');
    expect(r.value.projectId).toBeUndefined();
  });

  it('requires one of projectId / repoUrl', () => {
    expect(parseCreateBox({ agent: 'none' }).ok).toBe(false);
  });

  it('rejects sending BOTH projectId and repoUrl (ambiguous fork)', () => {
    const r = parseCreateBox({ projectId: 'p', repoUrl: 'https://x.git', agent: 'none' });
    expect(r.ok).toBe(false);
  });

  it('carries agentArgs, startAgent and foreground', () => {
    const r = parseCreateBox({
      projectId: 'p',
      agent: 'claude',
      agentArgs: ['--dangerously-skip-permissions'],
      startAgent: true,
      foreground: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.agentArgs).toEqual(['--dangerously-skip-permissions']);
    expect(r.value.startAgent).toBe(true);
    expect(r.value.foreground).toBe(true);
  });

  it('threads the create opts (image/snapshot/size/carry/gitPushMode/...) through', () => {
    const r = parseCreateBox({
      projectId: 'p',
      agent: 'none',
      opts: {
        image: 'agentbox/box:dev',
        snapshot: 'ckpt-1',
        size: 'cx33',
        bundleDepth: 50,
        build: true,
        gitPushMode: 'direct',
        envFiles: ['.env', 'secrets.toml'],
        carry: [{ absSrc: '/x' }],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.opts).toMatchObject({
      image: 'agentbox/box:dev',
      snapshot: 'ckpt-1',
      size: 'cx33',
      bundleDepth: 50,
      build: true,
      gitPushMode: 'direct',
      envFiles: ['.env', 'secrets.toml'],
    });
    expect(r.value.opts?.carry).toHaveLength(1);
  });

  it('threads promptAnswers and borrowCredentials through', () => {
    const r = parseCreateBox({
      projectId: 'p',
      agent: 'claude',
      opts: {
        promptAnswers: [{ id: 'carry:abc123', value: 'approve' }],
        borrowCredentials: ['codex'],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.opts?.promptAnswers).toEqual([{ id: 'carry:abc123', value: 'approve' }]);
    // `borrowCredentials` was read by the backend but never parsed here, so the
    // key was dead on the wire.
    expect(r.value.opts?.borrowCredentials).toEqual(['codex']);
  });

  it('threads the three carry decision flags through', () => {
    // `carrySkip` is the one a CLI create needs to say "the human already
    // declined": without it the hub re-asked the `required` carry prompt with no
    // terminal attached and refused the create.
    const r = parseCreateBox({
      projectId: 'p',
      agent: 'none',
      opts: { carryYes: true, carrySkip: false, carryAsk: true },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.opts).toMatchObject({ carryYes: true, carrySkip: false, carryAsk: true });
    expect(parseCreateBox({ projectId: 'p', agent: 'none', opts: { carrySkip: 'yes' } }).ok).toBe(
      false,
    );
  });

  it('rejects a malformed promptAnswers entry', () => {
    const bad = (promptAnswers: unknown) =>
      parseCreateBox({ projectId: 'p', agent: 'none', opts: { promptAnswers } }).ok;
    expect(bad('approve')).toBe(false);
    expect(bad([{ id: 'carry:abc' }])).toBe(false);
    expect(bad([{ value: 'approve' }])).toBe(false);
    expect(bad([{ id: 'carry:abc', value: 5 }])).toBe(false);
  });

  it('rejects a wrong-typed opts field and a bad gitPushMode', () => {
    expect(parseCreateBox({ projectId: 'p', agent: 'none', opts: { image: 5 } }).ok).toBe(false);
    expect(
      parseCreateBox({ projectId: 'p', agent: 'none', opts: { gitPushMode: 'nope' } }).ok,
    ).toBe(false);
    expect(parseCreateBox({ projectId: 'p', agent: 'none', opts: { bundleDepth: 'x' } }).ok).toBe(
      false,
    );
  });

  it('rejects an unknown agent', () => {
    expect(parseCreateBox({ projectId: 'p', agent: 'gpt' }).ok).toBe(false);
  });

  // GET /api/v1/agents offers whatever the registry knows, plugin agents
  // included, so the create path has to accept the same set — otherwise the API
  // advertises a choice it then refuses. The route supplies the live ids; the
  // default keeps the compiled-in behaviour for callers that can't reach the
  // registry (the hosted plane).
  it('accepts an agent outside the built-ins when the caller allows it', () => {
    expect(parseCreateBox({ projectId: 'p', agent: 'acme-agent' }).ok).toBe(false);
    const r = parseCreateBox({ projectId: 'p', agent: 'acme-agent' }, ['acme-agent', 'none']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.agent).toBe('acme-agent');
  });

  it('rejects a built-in that the caller left out of the accept-list', () => {
    expect(parseCreateBox({ projectId: 'p', agent: 'claude' }, ['pi', 'none']).ok).toBe(false);
  });
});

describe('parseCheckpointCreate', () => {
  it('accepts an empty/absent body (auto-named, layered, not-default)', () => {
    expect(parseCheckpointCreate(undefined)).toEqual({ ok: true, value: {} });
    expect(parseCheckpointCreate({})).toEqual({ ok: true, value: {} });
  });

  it('threads the capture options through', () => {
    const r = parseCheckpointCreate({
      name: 'warm',
      merged: true,
      setDefault: true,
      replace: false,
    });
    expect(r).toEqual({
      ok: true,
      value: { name: 'warm', merged: true, setDefault: true, replace: false },
    });
  });

  it('rejects wrong-typed fields', () => {
    expect(parseCheckpointCreate({ name: 5 }).ok).toBe(false);
    expect(parseCheckpointCreate({ merged: 'yes' }).ok).toBe(false);
    expect(parseCheckpointCreate('nope').ok).toBe(false);
  });
});

describe('parsePrune', () => {
  it('accepts an empty body (general prune, defaults)', () => {
    expect(parsePrune(undefined)).toEqual({ ok: true, value: {} });
    expect(parsePrune({})).toEqual({ ok: true, value: {} });
  });

  it('carries all / dryRun / provider', () => {
    expect(parsePrune({ all: true, dryRun: true, provider: 'e2b' })).toEqual({
      ok: true,
      value: { all: true, dryRun: true, provider: 'e2b' },
    });
  });

  it('rejects wrong-typed fields', () => {
    expect(parsePrune({ all: 'yes' }).ok).toBe(false);
    expect(parsePrune({ provider: 3 }).ok).toBe(false);
  });
});

describe('parseHostUpsert', () => {
  it('accepts a plain alias + ssh string (a host registered on this machine)', () => {
    const r = parseHostUpsert({ alias: 'buildbox', ssh: 'dev@10.0.0.9:2222' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ alias: 'buildbox', ssh: 'dev@10.0.0.9:2222', default: undefined });
  });

  it('carries the sharer’s ssh -G expansion', () => {
    const r = parseHostUpsert({
      alias: 'engine',
      ssh: 'buildbox',
      connection: { host: '10.0.0.9', user: 'dev', port: 2222 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.connection).toEqual({ host: '10.0.0.9', user: 'dev', port: 2222 });
  });

  it('rejects a connection.host that is itself an alias-shaped string', () => {
    for (const host of ['dev@10.0.0.9', 'a b', 'x/y']) {
      const r = parseHostUpsert({ alias: 'engine', ssh: 'x', connection: { host } });
      expect(r.ok).toBe(false);
    }
  });

  // The key is useless without somewhere to point it: `ssh` may be an alias only
  // the sending machine can resolve, so a key alone would authenticate nothing.
  it('refuses an identity with no connection', () => {
    const r = parseHostUpsert({
      alias: 'engine',
      ssh: 'buildbox',
      identity: '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/requires connection/);
  });

  it('refuses something that is not a private key, and one that is absurdly large', () => {
    const conn = { host: '10.0.0.9' };
    expect(
      parseHostUpsert({ alias: 'e', ssh: 'x', connection: conn, identity: 'hunter2' }).ok,
    ).toBe(false);
    expect(
      parseHostUpsert({
        alias: 'e',
        ssh: 'x',
        connection: conn,
        identity: `-----BEGIN OPENSSH PRIVATE KEY-----${'A'.repeat(20000)}`,
      }).ok,
    ).toBe(false);
  });

  it('accepts a well-formed share', () => {
    const r = parseHostUpsert({
      alias: 'engine',
      ssh: 'buildbox',
      connection: { host: '10.0.0.9', user: 'dev' },
      identity: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.identity).toContain('PRIVATE KEY');
  });
});

describe('parseCloneBox', () => {
  it('accepts an empty body — every field is optional', () => {
    const r = parseCloneBox({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({});
  });

  it('REJECTS a relative --into: cwd is client state and does not travel over an API', () => {
    // The regression: a relative path used to be `path.resolve`d inside the hub
    // process, so the clone landed under whatever directory the long-lived
    // daemon was started in — wrong for a local hub, meaningless for a remote one.
    for (const rel of ['./svc-hz', '../svc', 'svc-hz', 'a/b/c']) {
      const r = parseCloneBox({ into: rel });
      expect(r.ok, `${rel} must be refused`).toBe(false);
      if (r.ok) continue;
      expect(r.message).toMatch(/absolute/);
      expect(r.message).toContain(rel);
    }
  });

  it('accepts an absolute into, POSIX or Windows — the hub may be a different OS', () => {
    for (const abs of ['/home/vscode/clones/x', 'C:\\Users\\me\\x', '\\\\server\\share\\x']) {
      const r = parseCloneBox({ into: abs });
      expect(r.ok, `${abs} must be accepted`).toBe(true);
      if (!r.ok) continue;
      expect(r.value.into).toBe(abs);
    }
  });

  it('keeps persistent TRI-STATE — absent inherits the source box, false does not', () => {
    expect((parseCloneBox({}) as { value: { persistent?: boolean } }).value.persistent).toBe(
      undefined,
    );
    const off = parseCloneBox({ persistent: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.value.persistent).toBe(false);
    const on = parseCloneBox({ persistent: true });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.value.persistent).toBe(true);
  });

  it('rejects wrong-typed fields rather than coercing them', () => {
    expect(parseCloneBox({ name: 7 }).ok).toBe(false);
    expect(parseCloneBox({ persistent: 'yes' }).ok).toBe(false);
    expect(parseCloneBox({ includeNodeModules: 1 }).ok).toBe(false);
    expect(parseCloneBox('nope').ok).toBe(false);
  });
});

describe('parseWorkspaceAdd', () => {
  it('takes the scan the caller ran: host, absolute root, and its projects', () => {
    expect(
      parseWorkspaceAdd({
        host: 'laptop',
        root: '/Users/me/code',
        projects: [{ path: '/Users/me/code/app', repoUrl: 'git@github.com:acme/app.git' }],
      }),
    ).toMatchObject({
      ok: true,
      value: {
        host: 'laptop',
        root: '/Users/me/code',
        projects: [{ path: '/Users/me/code/app', repoUrl: 'git@github.com:acme/app.git' }],
      },
    });
    // The folder is the CALLER's, so a path this hub does not have is fine.
    expect(parseWorkspaceAdd({ host: 'laptop', root: '/not/here', projects: [] })).toMatchObject({
      ok: true,
    });
  });

  it('refuses a missing host, a relative path and a bad name or id', () => {
    const base = { host: 'laptop', root: '/a', projects: [] };
    expect(parseWorkspaceAdd({ root: '/a', projects: [] })).toMatchObject({ ok: false });
    expect(parseWorkspaceAdd({ ...base, root: 'code' })).toMatchObject({ ok: false });
    expect(parseWorkspaceAdd({})).toMatchObject({ ok: false });
    expect(parseWorkspaceAdd({ ...base, projects: [{ path: 'rel' }] })).toMatchObject({
      ok: false,
    });
    expect(parseWorkspaceAdd({ ...base, name: 'x'.repeat(61) })).toMatchObject({ ok: false });
    expect(parseWorkspaceAdd({ ...base, name: '   ' })).toMatchObject({ ok: false });
    expect(parseWorkspaceAdd({ ...base, id: 'not-an-id' })).toMatchObject({ ok: false });
    expect(parseWorkspaceAdd({ ...base, id: '0123456789abcdef' })).toMatchObject({ ok: true });
  });
});

describe('parseTaskCreate', () => {
  it('requires a non-empty title and trims it', () => {
    expect(parseTaskCreate({ title: '  ship it  ' })).toMatchObject({
      ok: true,
      value: { title: 'ship it' },
    });
    expect(parseTaskCreate({ title: '   ' })).toMatchObject({ ok: false });
    expect(parseTaskCreate({})).toMatchObject({ ok: false });
  });

  it('validates dependsOn ids, createdBy and the external ref', () => {
    expect(parseTaskCreate({ title: 'a', dependsOn: ['T-1', 'T-2'] })).toMatchObject({ ok: true });
    expect(parseTaskCreate({ title: 'a', dependsOn: ['nope'] })).toMatchObject({ ok: false });
    expect(parseTaskCreate({ title: 'a', createdBy: 'robot' })).toMatchObject({ ok: false });
    expect(parseTaskCreate({ title: 'a', externalRef: { kind: 'linear' } })).toMatchObject({
      ok: false,
    });
    expect(
      parseTaskCreate({ title: 'a', externalRef: { kind: 'linear', id: 'ENG-1' } }),
    ).toMatchObject({ ok: true });
  });

  it('refuses a task assigned to a box AND a job', () => {
    expect(parseTaskCreate({ title: 'a', boxId: 'b', boxJobId: 'j' })).toMatchObject({ ok: false });
  });
});

describe('parseTaskUpdate', () => {
  it('distinguishes a cleared project from an untouched one', () => {
    expect(parseTaskUpdate({ projectId: null })).toMatchObject({
      ok: true,
      value: { projectId: null },
    });
    const untouched = parseTaskUpdate({ title: 'x' });
    expect(untouched.ok && 'projectId' in untouched.value).toBe(false);
  });

  it('validates the status and refuses an empty patch', () => {
    expect(parseTaskUpdate({ status: 'done' })).toMatchObject({ ok: true });
    expect(parseTaskUpdate({ status: 'nope' })).toMatchObject({ ok: false });
    expect(parseTaskUpdate({})).toMatchObject({ ok: false });
  });

  it('accepts an empty dependsOn as "clear the dependencies"', () => {
    expect(parseTaskUpdate({ dependsOn: [] })).toMatchObject({
      ok: true,
      value: { dependsOn: [] },
    });
  });
});

describe('parseTaskAssign', () => {
  it('needs exactly one target', () => {
    expect(parseTaskAssign({ boxId: 'b' })).toMatchObject({ ok: true });
    expect(parseTaskAssign({ boxJobId: 'j' })).toMatchObject({ ok: true });
    expect(parseTaskAssign({})).toMatchObject({ ok: false });
    expect(parseTaskAssign({ boxId: 'b', boxJobId: 'j' })).toMatchObject({ ok: false });
  });

  it('requires task ids on the bulk form only', () => {
    expect(parseTaskAssign({ boxId: 'b' }, { requireIds: true })).toMatchObject({ ok: false });
    expect(parseTaskAssign({ ids: ['T-1'], boxId: 'b' }, { requireIds: true })).toMatchObject({
      ok: true,
    });
    expect(parseTaskAssign({ ids: ['oops'], boxId: 'b' }, { requireIds: true })).toMatchObject({
      ok: false,
    });
  });
});

describe('parseTaskReorder', () => {
  it('requires a non-empty list of task ids', () => {
    expect(parseTaskReorder({ ids: ['T-2', 'T-1'] })).toMatchObject({ ok: true });
    expect(parseTaskReorder({ ids: [] })).toMatchObject({ ok: false });
    expect(parseTaskReorder({})).toMatchObject({ ok: false });
  });
});

describe('parseManagerStart', () => {
  it('requires a known agent', () => {
    expect(parseManagerStart({ agent: 'claude' })).toMatchObject({ ok: true });
    expect(parseManagerStart({})).toMatchObject({ ok: false });
    expect(parseManagerStart({ agent: 'gemini' })).toMatchObject({ ok: false });
  });

  it('accepts an agent from the caller-supplied registry list', () => {
    expect(parseManagerStart({ agent: 'gemini' }, ['claude', 'gemini'])).toMatchObject({
      ok: true,
    });
  });

  it('refuses a free-form command — the manager runs on the hub host, not in a box', () => {
    expect(parseManagerStart({ argv: ['curl', 'evil.sh'] })).toMatchObject({ ok: false });
    const withArgv = parseManagerStart({ agent: 'claude', argv: ['curl'] });
    expect(withArgv.ok && 'argv' in withArgv.value).toBe(false);
  });

  it('refuses a sessionId that would read as a flag to the agent', () => {
    // The id lands in the agent's argv on the hub's OWN host, where both agents
    // expose a flag that drops their approval gate. Shell quoting does not help:
    // the agent's own parser is what reads it.
    for (const sessionId of [
      '--dangerously-skip-permissions',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      '--config=x',
      'has space',
      '../../etc/passwd',
    ]) {
      expect(parseManagerStart({ agent: 'claude', sessionId })).toMatchObject({ ok: false });
    }
    // A real id from either store still passes.
    expect(
      parseManagerStart({ agent: 'codex', sessionId: '01a07b01-5831-7302-b856-b0adfbfccad9' }),
    ).toMatchObject({ ok: true });
  });

  it('carries sessionId and restart through', () => {
    expect(parseManagerStart({ agent: 'claude', sessionId: 's1', restart: true })).toMatchObject({
      ok: true,
      value: { agent: 'claude', sessionId: 's1', restart: true },
    });
    expect(parseManagerStart({ agent: 'claude', restart: 'yes' })).toMatchObject({ ok: false });
  });

  /**
   * The default list is the compiled-in one, so a route that forgets to pass the
   * registry's ids 400s on an agent `GET /api/v1/agents` offers — which is what
   * the manager-start route did. Asserted at the source, because the route is a
   * Next handler with no test harness here.
   */
  it('is wired to the live registry by the manager-start route', () => {
    const route = readFileSync(
      join(
        __dirname,
        '..',
        'app',
        '(dashboard)',
        'api',
        'v1',
        'workspaces',
        '[id]',
        'managers',
        'start',
        'route.ts',
      ),
      'utf8',
    );
    expect(route).toContain('globalThis.__AGENTBOX_HUB_SYSTEM');
    expect(route).toMatch(/parseManagerStart\(parsedBody\.value,\s*allowedAgents\)/);
    // The accept-list comes from the registry, minus the daemon-shaped agents:
    // a `service` agent has no session to attach to, so a manager started on one
    // would be a tmux session nobody can use.
    expect(route).toMatch(/sys[\s\S]{0,80}\.agents\(\)/);
    expect(route).toMatch(/surface\s*!==\s*'service'/);
    expect(route).toMatch(/\.map\(\(a\)\s*=>\s*a\.id\)/);
  });
});

describe('parseManagerDetect', () => {
  const base = { agent: 'claude', sessionId: '5edc0ee0-ce9a-4e30-962d-bc630388d8bc', cwd: '/w' };

  it('accepts a session with its optional process facts', () => {
    expect(
      parseManagerDetect({ ...base, pid: 12, host: 'laptop', managerId: '0123456789abcdef' }),
    ).toMatchObject({
      ok: true,
      value: { pid: 12, host: 'laptop', managerId: '0123456789abcdef' },
    });
  });

  it('refuses what could not be a session', () => {
    expect(parseManagerDetect({ ...base, agent: 'openclaw' }, ['claude'])).toMatchObject({
      ok: false,
    });
    expect(
      parseManagerDetect({ ...base, sessionId: '--dangerously-skip-permissions' }),
    ).toMatchObject({
      ok: false,
    });
    expect(parseManagerDetect({ ...base, cwd: 'relative' })).toMatchObject({ ok: false });
    expect(parseManagerDetect({ ...base, pid: -1 })).toMatchObject({ ok: false });
    expect(parseManagerDetect({ ...base, pid: 1.5 })).toMatchObject({ ok: false });
    expect(parseManagerDetect({ ...base, managerId: 'nope' })).toMatchObject({ ok: false });
    expect(parseManagerDetect({ ...base, boxId: 'b', boxJobId: 'j' })).toMatchObject({ ok: false });
  });
});

describe('managerId on creates and tasks', () => {
  it('rides a box create and a task create, and null clears it on update', () => {
    expect(
      parseCreateBox({ projectId: 'p', agent: 'none', managerId: '0123456789abcdef' }),
    ).toMatchObject({ ok: true, value: { managerId: '0123456789abcdef' } });
    expect(parseCreateBox({ projectId: 'p', agent: 'none', managerId: 'x' }).ok).toBe(false);
    expect(parseTaskCreate({ title: 't', managerId: '0123456789abcdef' })).toMatchObject({
      ok: true,
      value: { managerId: '0123456789abcdef' },
    });
    expect(parseTaskUpdate({ managerId: null })).toMatchObject({
      ok: true,
      value: { managerId: null },
    });
    expect(parseTaskUpdate({ managerId: 'x' }).ok).toBe(false);
  });
});

describe('parseManagerMessage', () => {
  it('accepts a repo alongside prNumber and refuses a bad or orphan one', () => {
    expect(parseManagerMessage({ text: 'go', prNumber: 3, repo: 'o/r' })).toEqual({
      ok: true,
      value: { text: 'go', prNumber: 3, repo: 'o/r' },
    });
    expect(parseManagerMessage({ text: 'go', prNumber: 3, repo: 'o/r/x' }).ok).toBe(false);
    expect(parseManagerMessage({ text: 'go', prNumber: 3, repo: 7 }).ok).toBe(false);
    expect(parseManagerMessage({ text: 'go', repo: 'o/r' }).ok).toBe(false);
  });
});

describe('parseTimelineQuery', () => {
  const q = (search: string) => parseTimelineQuery(new URL(`http://h/t${search}`));
  it('turns sync=0 into sync: false and leaves any other value to the default', () => {
    expect(q('?limit=2&sync=0')).toEqual({ ok: true, value: { limit: 2, sync: false } });
    expect(q('?sync=1')).toEqual({ ok: true, value: {} });
    expect(q('?sync=')).toEqual({ ok: true, value: {} });
    expect(q('')).toEqual({ ok: true, value: {} });
  });
});
