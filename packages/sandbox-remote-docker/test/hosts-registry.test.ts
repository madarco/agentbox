import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertValidAlias,
  getHostAlias,
  isValidAlias,
  listHostAliases,
  removeHostAlias,
  requireHostAlias,
  resolveConnection,
  upsertHostAlias,
} from '../src/hosts-registry.js';

// The registry writes to `$HOME/.agentbox/remote-docker-hosts.json`. Point HOME
// at a throwaway dir so these tests never touch the developer's real registry.
let tmpHome: string | undefined;
let origHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'agentbox-hosts-test-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  origHome = undefined;
  if (tmpHome) {
    rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = undefined;
  }
});

describe('assertValidAlias', () => {
  it('accepts plain names', () => {
    for (const ok of ['macmini', 'build-box', 'host_1', 'a.b', 'H2']) {
      expect(isValidAlias(ok)).toBe(true);
      expect(() => assertValidAlias(ok)).not.toThrow();
    }
  });
  it('rejects connection-string-shaped or unsafe names', () => {
    for (const bad of ['marco@host', 'host:22', 'a/b', '', ' spaced', '-lead']) {
      expect(isValidAlias(bad)).toBe(false);
      expect(() => assertValidAlias(bad)).toThrow();
    }
  });
});

describe('upsert / get / list / remove', () => {
  it('registers, retrieves, and lists aliases sorted', () => {
    upsertHostAlias('zeta', 'marco@10.0.0.9');
    upsertHostAlias('alpha', 'buildbox');
    expect(getHostAlias('zeta')?.ssh).toBe('marco@10.0.0.9');
    expect(listHostAliases().map((a) => a.alias)).toEqual(['alpha', 'zeta']);
    // createdAt is stamped, updatedAt absent on first insert.
    expect(getHostAlias('alpha')?.createdAt).toBeTruthy();
    expect(getHostAlias('alpha')?.updatedAt).toBeUndefined();
  });

  it('update preserves createdAt and stamps updatedAt', () => {
    upsertHostAlias('macmini', 'marco@192.168.68.57');
    const created = getHostAlias('macmini')!.createdAt;
    upsertHostAlias('macmini', 'marco@192.168.68.99');
    const after = getHostAlias('macmini')!;
    expect(after.ssh).toBe('marco@192.168.68.99');
    expect(after.createdAt).toBe(created);
    expect(after.updatedAt).toBeTruthy();
  });

  it('remove drops one and reports presence', () => {
    upsertHostAlias('a', 'ha');
    upsertHostAlias('b', 'hb');
    expect(removeHostAlias('a')).toBe(true);
    expect(getHostAlias('a')).toBeUndefined();
    expect(getHostAlias('b')?.ssh).toBe('hb');
    expect(removeHostAlias('a')).toBe(false);
  });
});

describe('resolveConnection (lenient) vs requireHostAlias (strict)', () => {
  it('resolveConnection maps a registered alias, passes anything else through', () => {
    upsertHostAlias('macmini', 'marco@192.168.68.57');
    expect(resolveConnection('macmini')).toBe('marco@192.168.68.57');
    // Not registered → unchanged (keeps pre-registry / raw-baked ids reachable).
    expect(resolveConnection('marco@1.2.3.4')).toBe('marco@1.2.3.4');
    expect(resolveConnection('unknown')).toBe('unknown');
  });

  it('requireHostAlias returns the entry or throws a helpful error', () => {
    upsertHostAlias('macmini', 'marco@192.168.68.57');
    expect(requireHostAlias('macmini').ssh).toBe('marco@192.168.68.57');
    expect(() => requireHostAlias('nope')).toThrow(/no such remote-docker host alias/);
    expect(() => requireHostAlias('nope')).toThrow(/agentbox remote-docker add/);
  });
});
