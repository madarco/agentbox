import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxRecord, Provider } from '@agentbox/core';

// The live proxy mode is the test's: the network probe and the start are stubbed,
// as are the host reads (`state.json`, status snapshot, engine).
const { mode, records } = vi.hoisted(() => ({
  mode: { value: null as { port: number; tls: boolean } | null },
  records: { value: [] as unknown[] },
}));
vi.mock('../src/portless.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/portless.js')>();
  return {
    ...actual,
    ensurePortlessForUrl: vi.fn(async () => mode.value),
    livePortlessMode: vi.fn(async () => mode.value),
  };
});
vi.mock('../src/sync/host-export.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sync/host-export.js')>()),
  detectEngine: vi.fn(async () => 'docker-desktop'),
  readBoxStatus: vi.fn(async () => null),
}));
vi.mock('../src/state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/state.js')>()),
  readState: vi.fn(async () => ({ version: 1, boxes: records.value })),
}));

import { dockerProvider } from '../src/docker-provider.js';
import { listBoxes } from '../src/lifecycle.js';
import { resolveVncViewerUrl } from '../src/vnc.js';

const HTTPS = { port: 443, tls: true };

const dockerBox: BoxRecord = {
  id: 'd1',
  name: 'web1',
  container: 'agentbox-web1',
  image: 'agentbox/box:dev',
  workspacePath: '/tmp/ws',
  createdAt: '2026-11-27T00:00:00.000Z',
  provider: 'docker',
  webContainerPort: 80,
  webHostPort: 50080,
  vncEnabled: true,
  vncHostPort: 50600,
  vncPassword: 'pw',
  portlessAlias: 'web1',
  // Recorded on the no-root proxy; the live one may differ.
  portlessUrl: 'http://web1.localhost:1355',
  portlessVncAlias: 'vnc-web1',
  portlessVncUrl: 'http://vnc-web1.localhost:1355',
};

const cloudBox = {
  ...dockerBox,
  id: 'c1',
  name: 'cloud1',
  container: 'cloud:sb-1',
  provider: 'hetzner',
  portlessAlias: 'cloud1',
  portlessUrl: 'http://cloud1.localhost:1355',
  portlessVncAlias: 'vnc-cloud1',
  portlessVncUrl: 'http://vnc-cloud1.localhost:1355',
  cloud: {
    backend: 'hetzner',
    sandboxId: 'sb-1',
    webPort: 8080,
    previewUrls: { 8080: 'http://127.0.0.1:48080' },
  },
} as BoxRecord;

beforeEach(() => {
  mode.value = null;
  records.value = [];
});

describe('docker resolveUrl (the hub /web route the tray opens)', () => {
  it('returns the alias at the live proxy mode', async () => {
    mode.value = HTTPS;
    expect(await dockerProvider.resolveUrl(dockerBox, { kind: 'web' })).toBe(
      'https://web1.localhost',
    );
  });

  it('returns the loopback port while no proxy serves the alias', async () => {
    expect(await dockerProvider.resolveUrl(dockerBox, { kind: 'web' })).toBe(
      'http://127.0.0.1:50080',
    );
  });
});

describe('listBoxes, cloud branch', () => {
  it('advertises the alias at the live mode, else the preview URL', async () => {
    records.value = [cloudBox];
    const web = async () =>
      (await listBoxes())[0]?.endpoints.endpoints.find((e) => e.kind === 'web')?.url;
    const vnc = async () =>
      (await listBoxes())[0]?.endpoints.endpoints.find((e) => e.kind === 'vnc')?.url;
    expect(await web()).toBe('http://127.0.0.1:48080');
    expect(await vnc()).toBeUndefined();
    mode.value = HTTPS;
    expect(await web()).toBe('https://cloud1.localhost');
    expect(await vnc()).toBe('https://vnc-cloud1.localhost/vnc.html?autoconnect=1&password=pw');
  });
});

describe('resolveVncViewerUrl (docker)', () => {
  const provider = {} as Provider;

  it('opens the VNC alias at the live mode', async () => {
    mode.value = HTTPS;
    expect(await resolveVncViewerUrl(dockerBox, provider)).toBe(
      'https://vnc-web1.localhost/vnc.html?autoconnect=1&password=pw',
    );
  });

  it('falls back to the loopback viewer while no proxy serves it', async () => {
    expect(await resolveVncViewerUrl(dockerBox, provider)).toBe(
      'http://127.0.0.1:50600/vnc.html?autoconnect=1&password=pw',
    );
  });
});
