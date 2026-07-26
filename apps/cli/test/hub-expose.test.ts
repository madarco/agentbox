import { describe, expect, it } from 'vitest';
import type { ControlPlaneDeployRecord } from '@agentbox/sandbox-core';
import { buildExposedHubEnv, parseEnvFileBody } from '@agentbox/sandbox-core';
import { detectLanIp } from '../src/control-plane/expose.js';
import { parseTrycloudflareUrl, cloudflaredAsset } from '../src/control-plane/tunnel.js';
import { launchdPlist, systemdUnit } from '../src/lib/autostart.js';

const CREDS = {
  AGENTBOX_RELAY_ADMIN_TOKEN: 'admin-tok',
  AGENTBOX_HUB_API_KEY: 'api-key',
  BETTER_AUTH_SECRET: 'secret',
  AGENTBOX_HUB_ADMIN_EMAIL: 'me@example.com',
  AGENTBOX_HUB_ADMIN_PASSWORD: 'pw',
  GH_TOKEN: 'gh-tok',
};

describe('buildExposedHubEnv', () => {
  it('flips the hub to the exposed hetzner profile with the worker on', () => {
    const rec: ControlPlaneDeployRecord = { provider: 'local', publicUrl: 'https://x.trycloudflare.com', port: 8787 };
    const env = buildExposedHubEnv(rec, CREDS);
    expect(env.AGENTBOX_HUB_PROFILE).toBe('hetzner');
    expect(env.AGENTBOX_HUB_AUTH).toBe('on');
    expect(env.AGENTBOX_HUB_WORKER).toBe('on');
    expect(env.AGENTBOX_HUB_HOST).toBe('0.0.0.0');
    expect(env.AGENTBOX_HUB_PUBLIC_URL).toBe('https://x.trycloudflare.com');
  });

  it('honors an explicit loopback bind and a non-default port', () => {
    const env = buildExposedHubEnv({ provider: 'local', bind: '127.0.0.1', port: 8790 }, CREDS);
    expect(env.AGENTBOX_HUB_HOST).toBe('127.0.0.1');
    expect(env.AGENTBOX_HUB_PORT).toBe('8790');
  });

  it('carries the secrets from control-plane.env but nothing it does not have', () => {
    const env = buildExposedHubEnv({ provider: 'local' }, CREDS);
    expect(env.AGENTBOX_RELAY_ADMIN_TOKEN).toBe('admin-tok');
    expect(env.AGENTBOX_HUB_API_KEY).toBe('api-key');
    expect(env.BETTER_AUTH_SECRET).toBe('secret');
    expect(env.GH_TOKEN).toBe('gh-tok');
    // A key that isn't in the env map is simply absent (the hub fails closed).
    const bare = buildExposedHubEnv({ provider: 'local' }, {});
    expect(bare.GH_TOKEN).toBeUndefined();
    expect(bare.BETTER_AUTH_SECRET).toBeUndefined();
  });

  it('adds the admin CIDR only when recorded', () => {
    expect(buildExposedHubEnv({ provider: 'local' }, CREDS).AGENTBOX_HUB_ADMIN_CIDR).toBeUndefined();
    expect(
      buildExposedHubEnv({ provider: 'local', adminCidr: '1.2.3.4/32' }, CREDS).AGENTBOX_HUB_ADMIN_CIDR,
    ).toBe('1.2.3.4/32');
  });
});

describe('parseEnvFileBody', () => {
  it('parses KEY=VALUE lines, ignoring comments and blanks', () => {
    const map = parseEnvFileBody('# comment\nA=1\n\nB=two words\nnot-a-key\n');
    expect(map).toEqual({ A: '1', B: 'two words' });
  });
});

describe('detectLanIp', () => {
  it('returns the first non-internal IPv4', () => {
    const ip = detectLanIp({
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' } as never],
      eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.42' } as never],
    });
    expect(ip).toBe('192.168.1.42');
  });
  it('falls back to loopback when there is no external interface', () => {
    expect(detectLanIp({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' } as never] })).toBe('127.0.0.1');
  });
});

describe('parseTrycloudflareUrl', () => {
  it('extracts the quick-tunnel hostname from a cloudflared banner', () => {
    const log = 'INF |  https://brave-cats-run-12ab.trycloudflare.com  |\nINF Registered tunnel';
    expect(parseTrycloudflareUrl(log)).toBe('https://brave-cats-run-12ab.trycloudflare.com');
  });
  it('returns null before the URL is printed', () => {
    expect(parseTrycloudflareUrl('INF Starting tunnel')).toBeNull();
  });
});

describe('cloudflaredAsset', () => {
  it('maps darwin to a .tgz and linux to a raw binary', () => {
    expect(cloudflaredAsset('darwin', 'arm64')).toEqual({ file: 'cloudflared-darwin-arm64.tgz', isTgz: true });
    expect(cloudflaredAsset('linux', 'x64')).toEqual({ file: 'cloudflared-linux-amd64', isTgz: false });
  });
});

describe('autostart unit bodies', () => {
  const inv = { execPath: '/usr/bin/node', cliEntry: '/opt/agentbox/index.js' };

  it('launchd plist runs `hub start` at load and escapes XML', () => {
    const plist = launchdPlist(inv, '/home/me/.agentbox/hub.log');
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>hub</string>');
    expect(plist).toContain('<string>start</string>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(launchdPlist({ execPath: 'a&b', cliEntry: 'x' }, 'log')).toContain('a&amp;b');
  });

  it('systemd unit runs `hub start` and starts on default.target', () => {
    const unit = systemdUnit(inv);
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/agentbox/index.js hub start --no-open');
    expect(unit).toContain('WantedBy=default.target');
  });
});
