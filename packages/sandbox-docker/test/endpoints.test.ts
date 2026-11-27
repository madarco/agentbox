import { describe, expect, it } from 'vitest';
import type { BoxStatus } from '@agentbox/ctl';
import { getBoxEndpoints } from '../src/endpoints.js';
import type { BoxRecord } from '../src/state.js';

const baseRecord: BoxRecord = {
  id: 'abc123',
  name: 'mybox',
  container: 'agentbox-mybox',
  image: 'agentbox/box:dev',
  workspacePath: '/tmp/ws',
  snapshotDir: null,
  createdAt: '2026-05-21T00:00:00.000Z',
  webContainerPort: 80,
  webHostPort: 54321,
};

// A persisted snapshot whose single service is the `expose:`-flagged web app —
// enough for getBoxEndpoints to emit a reachable `web` endpoint without reading
// a host agentbox.yaml.
const webStatus: BoxStatus = {
  schema: 1,
  boxId: 'abc123',
  timestamp: '2026-05-21T00:00:00.000Z',
  services: [{ name: 'web', state: 'ready', port: 3000, expose: { port: 3000, as: 80 } }],
  tasks: [],
  ports: [],
  claude: { state: 'unknown', updatedAt: null, sessionRunning: false },
};

const NO_TLS = { port: 1355, tls: false };
const HTTPS = { port: 443, tls: true };

function webEndpoint(eps: Awaited<ReturnType<typeof getBoxEndpoints>>) {
  return eps.endpoints.find((e) => e.kind === 'web');
}

function vncEndpoint(eps: Awaited<ReturnType<typeof getBoxEndpoints>>) {
  return eps.endpoints.find((e) => e.kind === 'vnc');
}

describe('getBoxEndpoints — Portless web URL', () => {
  it('uses the stored portlessUrl on Docker Desktop', async () => {
    const record = {
      ...baseRecord,
      portlessAlias: 'mybox',
      portlessUrl: 'http://mybox.localhost:1355',
    };
    const eps = await getBoxEndpoints(record, 'docker-desktop', webStatus, NO_TLS);
    expect(webEndpoint(eps)?.url).toBe('http://mybox.localhost:1355');
    expect(webEndpoint(eps)?.reachable).toBe(true);
  });

  it('follows the live proxy mode, not the URL recorded at create', async () => {
    // Created on the no-root :1355 proxy; the host has since moved to :443.
    const record = {
      ...baseRecord,
      portlessAlias: 'mybox',
      portlessUrl: 'http://mybox.localhost:1355',
    };
    const eps = await getBoxEndpoints(record, 'docker-desktop', webStatus, HTTPS);
    expect(webEndpoint(eps)?.url).toBe('https://mybox.localhost');
  });

  it('falls back to loopback when the proxy serving the alias is down', async () => {
    const record = {
      ...baseRecord,
      portlessAlias: 'mybox',
      portlessUrl: 'https://mybox.localhost',
    };
    const eps = await getBoxEndpoints(record, 'docker-desktop', webStatus, null);
    expect(webEndpoint(eps)?.url).toBe('http://127.0.0.1:54321');
    expect(webEndpoint(eps)?.reachable).toBe(true);
  });

  it('falls back to loopback when no Portless route is registered', async () => {
    const eps = await getBoxEndpoints(baseRecord, 'docker-desktop', webStatus);
    expect(webEndpoint(eps)?.url).toBe('http://127.0.0.1:54321');
  });

  it('ignores the Portless route on OrbStack (orb.local is preferred)', async () => {
    const record = {
      ...baseRecord,
      portlessAlias: 'mybox',
      portlessUrl: 'http://mybox.localhost:1355',
    };
    const eps = await getBoxEndpoints(record, 'orbstack', webStatus);
    expect(webEndpoint(eps)?.url).toBe('http://127.0.0.1:54321');
  });
});

describe('getBoxEndpoints — Portless VNC URL', () => {
  const vncBase: BoxRecord = {
    ...baseRecord,
    vncEnabled: true,
    vncContainerPort: 6080,
    vncHostPort: 64080,
    vncPassword: 'pw12345A',
  };

  it('uses the stored portlessVncUrl on Docker Desktop', async () => {
    const record = {
      ...vncBase,
      portlessVncAlias: 'vnc-mybox',
      portlessVncUrl: 'http://vnc-mybox.localhost:1355',
    };
    const eps = await getBoxEndpoints(record, 'docker-desktop', webStatus, NO_TLS);
    expect(vncEndpoint(eps)?.url).toBe(
      'http://vnc-mybox.localhost:1355/vnc.html?autoconnect=1&password=pw12345A',
    );
    expect(vncEndpoint(eps)?.reachable).toBe(true);
  });

  it('follows the live proxy mode for the VNC alias too', async () => {
    const record = {
      ...vncBase,
      portlessVncAlias: 'vnc-mybox',
      portlessVncUrl: 'http://vnc-mybox.localhost:1355',
    };
    const eps = await getBoxEndpoints(record, 'docker-desktop', webStatus, HTTPS);
    expect(vncEndpoint(eps)?.url).toBe(
      'https://vnc-mybox.localhost/vnc.html?autoconnect=1&password=pw12345A',
    );
  });

  it('falls back to the loopback VNC URL when the proxy is down', async () => {
    const record = {
      ...vncBase,
      portlessVncAlias: 'vnc-mybox',
      portlessVncUrl: 'https://vnc-mybox.localhost',
    };
    const eps = await getBoxEndpoints(record, 'docker-desktop', webStatus, null);
    expect(vncEndpoint(eps)?.url).toBe(
      'http://127.0.0.1:64080/vnc.html?autoconnect=1&password=pw12345A',
    );
  });

  it('falls back to loopback VNC URL when no Portless route is registered', async () => {
    const eps = await getBoxEndpoints(vncBase, 'docker-desktop', webStatus);
    expect(vncEndpoint(eps)?.url).toBe(
      'http://127.0.0.1:64080/vnc.html?autoconnect=1&password=pw12345A',
    );
  });

  it('ignores the Portless VNC route on OrbStack (orb.local is preferred)', async () => {
    const record = {
      ...vncBase,
      portlessVncAlias: 'vnc-mybox',
      portlessVncUrl: 'http://vnc-mybox.localhost:1355',
    };
    const eps = await getBoxEndpoints(record, 'orbstack', webStatus);
    expect(vncEndpoint(eps)?.url).toBe(
      'http://agentbox-mybox.orb.local:6080/vnc.html?autoconnect=1&password=pw12345A',
    );
  });

  it('omits the VNC endpoint when vncEnabled is false', async () => {
    const eps = await getBoxEndpoints(baseRecord, 'docker-desktop', webStatus);
    expect(vncEndpoint(eps)).toBeUndefined();
  });
});
