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
  hubBearerFor,
} from '../src/hub-device.js';
import { scrubControlPlaneHubEnv } from '../src/hub-expose.js';
import { mkdirSync, writeFileSync } from 'node:fs';

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

describe('hubBearerFor (#4, #6)', () => {
  const A = 'https://old-hub.example.com';
  const B = 'https://hub.example.com';
  const writeFileEnv = (body: string) => {
    mkdirSync(join(home, '.agentbox', 'control-plane'), { recursive: true });
    writeFileSync(join(home, '.agentbox', 'control-plane', 'control-plane.env'), body);
  };

  it("never sends hub B's device token to a box's older hub A", () => {
    writeDeviceCredential({ ...cred, hubUrl: B }, home);
    // The env holds B's device token (loadControlPlaneEnv for the configured hub).
    const env = { AGENTBOX_RELAY_ADMIN_TOKEN: 'abdev_tok', AGENTBOX_HUB_API_KEY: 'abdev_tok' };
    expect(hubBearerFor(A, 'admin', { configuredUrl: B, env, home })).toBe('');
    expect(hubBearerFor(B, 'admin', { configuredUrl: B, env, home })).toBe('abdev_tok');
  });

  it('the shared key on disk goes only to the hub it was written for', () => {
    writeFileEnv('AGENTBOX_HUB_API_KEY=shared\n');
    const env = { AGENTBOX_HUB_API_KEY: 'shared' }; // copied in by loadControlPlaneEnv
    expect(hubBearerFor(B, 'api', { configuredUrl: B, env, home })).toBe('shared');
    expect(hubBearerFor(A, 'api', { configuredUrl: B, env, home })).toBe('');
  });

  it('an explicitly exported shared key beats the device token (operator override)', () => {
    writeDeviceCredential({ ...cred, hubUrl: B }, home);
    const env = { AGENTBOX_HUB_API_KEY: 'operator-key' };
    expect(hubBearerFor(B, 'api', { configuredUrl: B, env, home })).toBe('operator-key');
  });

  it('the device token beats the shared key on disk', () => {
    writeDeviceCredential({ ...cred, hubUrl: B }, home);
    writeFileEnv('AGENTBOX_HUB_API_KEY=shared\n');
    expect(hubBearerFor(B, 'api', { configuredUrl: B, env: {}, home })).toBe('abdev_tok');
  });
});

describe('scrubControlPlaneHubEnv', () => {
  it('drops a device token from the local hub env, keeps a shared admin token', () => {
    expect(scrubControlPlaneHubEnv({ AGENTBOX_RELAY_ADMIN_TOKEN: 'abdev_x' })).toEqual({});
    expect(scrubControlPlaneHubEnv({ AGENTBOX_RELAY_ADMIN_TOKEN: 'shared' })).toEqual({
      AGENTBOX_RELAY_ADMIN_TOKEN: 'shared',
    });
  });
});
