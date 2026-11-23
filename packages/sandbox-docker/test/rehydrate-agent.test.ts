import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rehydrateRelayRegistry } from '../src/relay.js';

/**
 * A rehydrate (relay restart, any docker create) re-registers every box, and a
 * registration REPLACES the entry. Without the agent an openclaw box looked
 * agentless afterwards and its gateway was not started on the next ctl boot.
 */
describe('rehydrateRelayRegistry', () => {
  let server: Server;
  const bodies: Array<Record<string, unknown>> = [];
  let prevPort: string | undefined;

  beforeEach(async () => {
    bodies.length = 0;
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.statusCode = 204;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    prevPort = process.env.AGENTBOX_RELAY_PORT;
    process.env.AGENTBOX_RELAY_PORT = String((server.address() as AddressInfo).port);
  });
  afterEach(async () => {
    if (prevPort === undefined) delete process.env.AGENTBOX_RELAY_PORT;
    else process.env.AGENTBOX_RELAY_PORT = prevPort;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('re-registers each box with its own agent', async () => {
    await rehydrateRelayRegistry([
      { id: 'b-claw', name: 'claw', relayToken: 't1', agents: ['openclaw'] },
      { id: 'b-tui', name: 'tui', relayToken: 't2', lastAgent: 'claude' },
      { id: 'b-none', name: 'none', relayToken: 't3' },
    ]);
    const agentOf = (id: string) => bodies.find((b) => b.boxId === id)?.agent;
    expect(agentOf('b-claw')).toBe('openclaw');
    expect(agentOf('b-tui')).toBe('claude');
    expect(agentOf('b-none')).toBeUndefined();
  });

  it('re-registers the full agents list, repo identity and origin stamp from the record', async () => {
    await rehydrateRelayRegistry([
      {
        id: 'b-both',
        name: 'both',
        relayToken: 't',
        agents: ['claude', 'openclaw'],
        originUrl: 'git@github.com:o/r.git',
        repoKey: 'github.com/o/r',
        originMachineId: 'pc-1',
        originFolder: '/home/u/r',
        llmProxy: { mode: 'forward', upstream: 'hub.example.com:8790' },
      },
    ]);
    expect(bodies[0]).toMatchObject({
      agent: 'claude',
      agents: ['claude', 'openclaw'],
      originUrl: 'git@github.com:o/r.git',
      repoKey: 'github.com/o/r',
      originMachineId: 'pc-1',
      originFolder: '/home/u/r',
      llmProxy: { mode: 'forward', upstream: 'hub.example.com:8790' },
    });
  });

  it('reads a cloud record as stored (cloud fields nested), as the docker create passes it', async () => {
    await rehydrateRelayRegistry([
      {
        id: 'b-cloud',
        name: 'c',
        relayToken: 't',
        provider: 'hetzner',
        cloud: {
          backend: 'hetzner',
          sandboxId: 's',
          relayPreviewUrl: 'https://bridge.example',
          bridgeToken: 'bt',
        },
      } as never,
    ]);
    expect(bodies[0]).toMatchObject({
      kind: 'cloud',
      backend: 'hetzner',
      previewUrl: 'https://bridge.example',
      bridgeToken: 'bt',
    });
  });

  it('a re-register never stamps this machine as the origin (an adopted box with no recorded stamp)', async () => {
    await rehydrateRelayRegistry([
      {
        id: 'b-adopted',
        name: 'a',
        relayToken: 't',
        originUrl: 'git@github.com:o/r.git',
        repoKey: 'github.com/o/r',
        gitWorktrees: [
          {
            kind: 'root',
            branch: 'agentbox/a',
            containerPath: '/workspace',
            hostMainRepo: '/some/other/pc/folder',
            gitWorktreePath: '',
            relPathFromWorkspace: '',
          },
        ],
      },
    ]);
    expect(bodies[0]).toMatchObject({ repoKey: 'github.com/o/r' });
    expect(bodies[0]?.originMachineId).toBeUndefined();
    expect(bodies[0]?.originFolder).toBeUndefined();
  });
});
