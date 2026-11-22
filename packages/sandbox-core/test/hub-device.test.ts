import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyDeviceCredentialEnv,
  deviceCredentialPath,
  deviceTokenFor,
  readDeviceCredential,
  removeDeviceCredential,
  writeDeviceCredential,
} from '../src/hub-device.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hub-device-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const cred = {
  hubUrl: 'https://hub.example.com/',
  deviceId: '0123456789abcdef0123456789abcdef',
  label: 'pc-b',
  token: 'abdev_tok',
  enrolledAt: '2026-11-22T00:00:00.000Z',
};

describe('device credential file', () => {
  it('writes 0600, normalizes the URL, and reads back', () => {
    writeDeviceCredential(cred, home);
    expect(statSync(deviceCredentialPath(home)).mode & 0o777).toBe(0o600);
    expect(readDeviceCredential(home)).toEqual({ ...cred, hubUrl: 'https://hub.example.com' });
    expect(removeDeviceCredential(home)).toBe(true);
    expect(readDeviceCredential(home)).toBeNull();
    expect(removeDeviceCredential(home)).toBe(false);
  });

  it('only ever hands the token to the hub that issued it', () => {
    writeDeviceCredential(cred, home);
    expect(deviceTokenFor('https://hub.example.com', home)).toBe('abdev_tok');
    expect(deviceTokenFor('https://other.example.com', home)).toBe('');
    expect(deviceTokenFor('', home)).toBe('');
  });

  it('fills both hub credentials, never overwriting an explicit one', () => {
    writeDeviceCredential(cred, home);
    const env: NodeJS.ProcessEnv = { AGENTBOX_HUB_API_KEY: 'explicit' };
    expect(applyDeviceCredentialEnv(env, 'https://hub.example.com', home)?.deviceId).toBe(
      cred.deviceId,
    );
    expect(env.AGENTBOX_HUB_API_KEY).toBe('explicit');
    expect(env.AGENTBOX_RELAY_ADMIN_TOKEN).toBe('abdev_tok');

    const other: NodeJS.ProcessEnv = {};
    expect(applyDeviceCredentialEnv(other, 'https://other.example.com', home)).toBeNull();
    expect(other).toEqual({});
  });
});
