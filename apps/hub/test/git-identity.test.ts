import { rmSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The hub default lives in the global config, whose path is fixed from $HOME at
// import: move HOME before any import.
const HOME = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: td } = require('node:os') as typeof import('node:os');
  const home = mk(`${td()}/agentbox-gitid-`);
  process.env.HOME = home;
  return home;
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

import { gitIdentityFieldProblem as coreRule } from '@agentbox/core';
import {
  gitIdentityFieldProblem as browserRule,
  parseCreateBox,
} from '../app/(dashboard)/api/v1/lib/validate';
import {
  createGitIdentity,
  createGitIdentityBackend,
  readHubGitIdentity,
} from '../lib/backend/git-identity';
import { controlPlaneCreateRequest } from '../lib/boxes/control-plane-create';

const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };
const TEAM = { name: 'Team Bot', email: 'bot@example.com' };

describe('opts.gitIdentity on POST /api/v1/boxes', () => {
  const create = (gitIdentity: unknown) =>
    parseCreateBox({
      repoUrl: 'https://github.com/acme/w.git',
      agent: 'claude',
      provider: 'hetzner',
      opts: { gitIdentity },
    });

  it('accepts a name and email', () => {
    const r = create(ADA);
    expect(r.ok && r.value.opts?.gitIdentity).toEqual(ADA);
  });

  it('rejects a newline in either half', () => {
    const name = create({ name: 'Ada\nLovelace', email: ADA.email });
    expect(name.ok).toBe(false);
    if (!name.ok) expect(name.message).toMatch(/opts\.gitIdentity\.name.*newlines/);
    expect(create({ name: ADA.name, email: 'ada@example.com\n[core]' }).ok).toBe(false);
  });

  it('rejects a missing half, a non-object and an over-long value', () => {
    expect(create({ name: ADA.name }).ok).toBe(false);
    expect(create('Ada <ada@example.com>').ok).toBe(false);
    expect(create({ name: 'a'.repeat(257), email: ADA.email }).ok).toBe(false);
  });

  it('restates the core rule exactly (validate.ts cannot import @agentbox/core)', () => {
    for (const v of ['Ada', ' ', '', 'a\tb', 'x'.repeat(256), 'x'.repeat(257), 7, null, 'é ü']) {
      expect(browserRule(v, 'f')).toBe(coreRule(v, 'f'));
    }
  });

  it('travels to the worker as a portable key', () => {
    const m = controlPlaneCreateRequest(
      { provider: 'hetzner', opts: { gitIdentity: ADA } },
      'https://github.com/acme/w.git',
    );
    expect(m.ok && m.request.opts?.gitIdentity).toEqual(ADA);
    expect(m.ok && m.dropped).toEqual([]);
  });
});

describe('the hub default (GET/PUT /api/v1/settings/git-identity)', () => {
  const backend = createGitIdentityBackend({ cwd: HOME });

  beforeEach(async () => {
    await backend.setHubGitIdentity({ identity: null });
  });

  it('is unset on a fresh hub', async () => {
    expect(await backend.getHubGitIdentity()).toEqual({ identity: null });
    expect(await readHubGitIdentity(HOME)).toBeUndefined();
  });

  it('sets, reads back and clears', async () => {
    expect(await backend.setHubGitIdentity({ identity: TEAM })).toEqual({
      ok: true,
      value: { identity: TEAM },
    });
    expect(await readHubGitIdentity(HOME)).toEqual(TEAM);
    await backend.setHubGitIdentity({ identity: null });
    expect(await readHubGitIdentity(HOME)).toBeUndefined();
  });

  it('ifUnset fills an empty hub but never replaces a chosen identity', async () => {
    const first = await backend.setHubGitIdentity({ identity: TEAM, ifUnset: true });
    expect(first).toEqual({ ok: true, value: { identity: TEAM } });
    const second = await backend.setHubGitIdentity({ identity: ADA, ifUnset: true });
    expect(second).toEqual({ ok: true, value: { identity: TEAM, unchanged: true } });
    expect(await readHubGitIdentity(HOME)).toEqual(TEAM);
  });

  it('refuses a newline', async () => {
    const r = await backend.setHubGitIdentity({ identity: { name: 'a\nb', email: ADA.email } });
    expect(r.ok).toBe(false);
  });
});

describe('the identity a hub-built box gets', () => {
  it('is resolved the same way on both hub create paths (clones and folders on the hub)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = (f: string) => readFileSync(join(__dirname, '..', 'lib', f), 'utf8');
    // The folder path once forwarded only the request's identity, so a web or
    // tray create from a project folder on the hub skipped the hub default.
    expect(src('hub-backend.ts')).toContain('await createGitIdentity(o.gitIdentity)');
    expect(src('hub-worker.ts')).toContain('await createGitIdentity(createOpts?.gitIdentity)');
  });

  it("is the requester's when the request carries one", async () => {
    expect(await createGitIdentity(ADA, () => Promise.resolve(TEAM))).toEqual({
      ...ADA,
      source: 'request',
    });
  });

  it('is the hub default when the request carries none (a web or tray create)', async () => {
    expect(await createGitIdentity(undefined, () => Promise.resolve(TEAM))).toEqual({
      ...TEAM,
      source: 'hub-default',
    });
  });

  it("reads the hub's configured default by default", async () => {
    const backend = createGitIdentityBackend({ cwd: HOME });
    await backend.setHubGitIdentity({ identity: TEAM });
    expect(await createGitIdentity(undefined)).toEqual({ ...TEAM, source: 'hub-default' });
    await backend.setHubGitIdentity({ identity: null });
  });

  it("is left to the provider (this machine's git config, then the fallback) when neither is set", async () => {
    expect(await createGitIdentity(undefined, () => Promise.resolve(undefined))).toBeUndefined();
  });
});
