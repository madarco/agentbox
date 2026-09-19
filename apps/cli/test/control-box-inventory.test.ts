/**
 * The control box's provider inventory — one read behind both the text reports
 * (`prepare --status`, `doctor`) and `doctor --json`'s `controlBox` block, so the
 * two can never disagree about which machine builds cloud boxes.
 */

import { describe, expect, it } from 'vitest';
import {
  buildControlBoxInventory,
  renderControlBoxInventory,
  type ControlBoxInventoryDeps,
} from '../src/control-plane/control-box-inventory.js';
import type { HubApiProvider } from '../src/control-plane/hub-api-client.js';

function deps(over: Partial<ControlBoxInventoryDeps> = {}): ControlBoxInventoryDeps {
  return {
    coLocated: () => Promise.resolve(false),
    target: () => Promise.resolve({ url: 'https://cp.example' }),
    reachable: () => Promise.resolve(true),
    listProviders: () => Promise.resolve([]),
    ...over,
  };
}

const provider = (over: Partial<HubApiProvider> & { id: string }): HubApiProvider => ({
  label: over.id,
  configured: true,
  hasCredentials: true,
  ...over,
});

describe('buildControlBoxInventory', () => {
  it('is null when no control box resolves', async () => {
    expect(
      await buildControlBoxInventory(deps({ target: () => Promise.resolve(null) })),
    ).toBeNull();
  });

  it('is null when the control box IS this machine', async () => {
    expect(await buildControlBoxInventory(deps({ coLocated: () => Promise.resolve(true) }))).toBe(
      null,
    );
  });

  it('reports the cloud providers with their credential + bake state', async () => {
    const inv = await buildControlBoxInventory(
      deps({
        listProviders: () =>
          Promise.resolve([
            provider({ id: 'e2b', baseStatus: 'fresh' }),
            provider({ id: 'hetzner', configured: false }),
            provider({ id: 'vercel', hasCredentials: false, configured: false }),
            // A docker engine is a local machine's business, never the control box's.
            provider({ id: 'docker' }),
            provider({ id: 'remote-docker' }),
          ]),
      }),
    );
    expect(inv?.reachable).toBe(true);
    expect(inv?.url).toBe('https://cp.example');
    expect(inv?.providers.map((p) => [p.id, p.state])).toEqual([
      ['e2b', 'fresh'],
      ['hetzner', 'not baked'],
      ['vercel', 'no credentials'],
    ]);
  });

  it('marks an unreachable control box rather than omitting it', async () => {
    const unreachable = await buildControlBoxInventory(
      deps({ reachable: () => Promise.resolve(false) }),
    );
    expect(unreachable).toEqual({
      url: 'https://cp.example',
      reachable: false,
      error: 'could not read its baked providers',
      providers: [],
    });
    // A provider read that fails against a reachable host reads the same way.
    const failed = await buildControlBoxInventory(
      deps({ listProviders: () => Promise.resolve(null) }),
    );
    expect(failed?.reachable).toBe(false);
  });
});

describe('renderControlBoxInventory', () => {
  it('renders nothing when there is no inventory, or no cloud provider on it', () => {
    expect(renderControlBoxInventory(null)).toEqual([]);
    expect(
      renderControlBoxInventory({ url: 'https://cp.example', reachable: true, providers: [] }),
    ).toEqual([]);
  });

  it('renders the same block the text reports have always printed', () => {
    expect(
      renderControlBoxInventory({
        url: 'https://cp.example',
        reachable: true,
        providers: [
          {
            id: 'e2b',
            hasCredentials: true,
            configured: true,
            baseStatus: 'fresh',
            state: 'fresh',
          },
        ],
      }),
    ).toEqual(['', 'control box (where cloud boxes are built):', '  e2b              fresh']);
  });

  it('renders the unreachable line', () => {
    expect(
      renderControlBoxInventory({
        url: 'https://cp.example',
        reachable: false,
        error: 'could not read its baked providers',
        providers: [],
      }),
    ).toEqual(['', 'control box: unreachable — could not read its baked providers']);
  });
});
