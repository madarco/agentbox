// `status --inspect` reads live status from the hub, but a status read must
// never start a stopped local hub: its spinner would land in `--json` stdout.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveHubApiTarget = vi.fn(async () => null);
vi.mock('../src/commands/control-plane.js', () => ({ resolveHubApiTarget }));
vi.mock('../src/commands/hub.js', () => ({
  resolveHubTarget: async () => ({ mode: 'local', url: 'http://127.0.0.1:1', token: 't' }),
}));
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return {
    ...real,
    readFile: async (...a: Parameters<typeof real.readFile>) => {
      if (String(a[0]).endsWith('hub-boxes-cache.json')) {
        return JSON.stringify({
          version: 1,
          fetchedAt: '2026-11-25T00:00:00Z',
          boxes: [{ id: 'b1', agentStatus: { claude: { state: 'working' } } }],
        });
      }
      return real.readFile(...a);
    },
  };
});

const { fetchBoxListing } = await import('../src/control-plane/hub-list.js');
const { hubRowFor } = await import('../src/commands/inspect.js');

beforeEach(() => {
  resolveHubApiTarget.mockClear();
});

describe('quiet hub listing', () => {
  it('fetchBoxListing({ quiet }) asks the resolver not to autostart', async () => {
    await fetchBoxListing({ quiet: true });
    expect(resolveHubApiTarget).toHaveBeenCalledWith(undefined, { quiet: true });
  });
  it('inspect reads quietly, and a cached listing is not live status', async () => {
    expect(await hubRowFor({ id: 'b1' })).toBeNull();
    expect(resolveHubApiTarget).toHaveBeenCalledWith(undefined, { quiet: true });
  });
});
