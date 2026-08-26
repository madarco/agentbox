import { describe, expect, it } from 'vitest';
import {
  parseCheckpointCreate,
  parseCreateBox,
  parseHostUpsert,
  parsePrune,
} from '../app/(dashboard)/api/v1/lib/validate';

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
