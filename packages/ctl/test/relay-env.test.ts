import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { relayEnvFilePath, resolveRelayEnv, writeRelayEnvFile } from '../src/relay-env.js';

describe('relay-env', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentbox-relay-env-'));
    for (const k of ['AGENTBOX_RELAY_URL', 'AGENTBOX_RELAY_TOKEN', 'AGENTBOX_RELAY_ENV_FILE']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.AGENTBOX_RELAY_ENV_FILE = join(dir, 'relay.env');
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('prefers process env over the file', () => {
    process.env.AGENTBOX_RELAY_URL = 'http://env';
    process.env.AGENTBOX_RELAY_TOKEN = 'env-tok';
    writeRelayEnvFile('http://file', 'file-tok');
    expect(resolveRelayEnv()).toEqual({ url: 'http://env', token: 'env-tok' });
  });

  it('falls back to the file when env is absent', () => {
    writeRelayEnvFile('http://127.0.0.1:8788', 'file-tok');
    expect(resolveRelayEnv()).toEqual({ url: 'http://127.0.0.1:8788', token: 'file-tok' });
  });

  it('fills only the missing half from the file', () => {
    process.env.AGENTBOX_RELAY_URL = 'http://env';
    writeRelayEnvFile('http://file', 'file-tok');
    expect(resolveRelayEnv()).toEqual({ url: 'http://env', token: 'file-tok' });
  });

  it('returns undefineds when neither env nor file is present', () => {
    expect(resolveRelayEnv()).toEqual({ url: undefined, token: undefined });
  });

  it('writeRelayEnvFile writes 0600 with both keys and no bridge token', () => {
    writeRelayEnvFile('http://127.0.0.1:8788', 'secret');
    const path = relayEnvFilePath();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const body = readFileSync(path, 'utf8');
    expect(body).toContain('AGENTBOX_RELAY_URL=http://127.0.0.1:8788');
    expect(body).toContain('AGENTBOX_RELAY_TOKEN=secret');
    expect(body).not.toContain('BRIDGE');
  });

  it('writeRelayEnvFile re-tightens perms on an existing looser file', () => {
    writeRelayEnvFile('http://a', 't1');
    // Second write (file exists) must still end at 0600.
    writeRelayEnvFile('http://b', 't2');
    expect(statSync(relayEnvFilePath()).mode & 0o777).toBe(0o600);
    expect(resolveRelayEnv()).toEqual({ url: 'http://b', token: 't2' });
  });
});
