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

function webEndpoint(eps: Awaited<ReturnType<typeof getBoxEndpoints>>) {
  return eps.endpoints.find((e) => e.kind === 'web');
}

describe('getBoxEndpoints — Portless web URL', () => {
  it('uses the stored portlessUrl on Docker Desktop', async () => {
    const record = {
      ...baseRecord,
      portlessAlias: 'mybox',
      portlessUrl: 'http://mybox.localhost:1355',
    };
    const eps = await getBoxEndpoints(record, 'docker-desktop', webStatus);
    expect(webEndpoint(eps)?.url).toBe('http://mybox.localhost:1355');
    expect(webEndpoint(eps)?.reachable).toBe(true);
  });

  it('falls back to https://<alias>.localhost when portlessUrl is absent', async () => {
    const record = { ...baseRecord, portlessAlias: 'mybox' };
    const eps = await getBoxEndpoints(record, 'docker-desktop', webStatus);
    expect(webEndpoint(eps)?.url).toBe('https://mybox.localhost');
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
