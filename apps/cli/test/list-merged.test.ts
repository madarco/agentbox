import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `agentbox ls` and `agentbox dashboard` must answer "what boxes exist" the same
 * way — that they didn't is why a hub-created box showed in one and not the
 * other. These pin the shared listing, not the merge rules (covered by
 * hub-merge's own tests).
 */

describe('listBoxesMerged', () => {
  let home: string;
  const originalHome = process.env['HOME'];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentbox-merged-test-'));
    process.env['HOME'] = home;
    vi.resetModules();
  });

  afterEach(async () => {
    vi.resetModules();
    vi.doUnmock('@agentbox/sandbox-docker');
    vi.doUnmock('../src/control-plane/hub-list.js');
    process.env['HOME'] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  const localBox = {
    id: 'local-1',
    name: 'local-1',
    provider: 'docker',
    container: 'agentbox-local-1',
    state: 'running',
    endpoints: { domain: '', domainIsOrb: false, endpoints: [] },
    shellSessions: [],
    codexSession: null,
    opencodeSession: null,
  };

  it('surfaces a hub-only box alongside the local ones', async () => {
    vi.doMock('@agentbox/sandbox-docker', () => ({ listBoxes: async () => [localBox] }));
    vi.doMock('../src/control-plane/hub-list.js', () => ({
      fetchHubListing: async () => ({
        registrations: [
          { boxId: 'hub-1', name: 'hub-1', backend: 'e2b', sandboxId: 'sbx_1', registeredAt: '' },
        ],
      }),
    }));

    const { listBoxesMerged } = await import('../src/control-plane/list-merged.js');
    const { boxes } = await listBoxesMerged();

    expect(boxes.map((b) => b.id).sort()).toEqual(['hub-1', 'local-1']);
    expect(boxes.find((b) => b.id === 'hub-1')?.needsAdopt).toBe(true);
    expect(boxes.find((b) => b.id === 'local-1')?.source).toBe('local');
  });

  it('degrades to the local boxes when the control box cannot be reached', async () => {
    vi.doMock('@agentbox/sandbox-docker', () => ({ listBoxes: async () => [localBox] }));
    vi.doMock('../src/control-plane/hub-list.js', () => ({
      fetchHubListing: async () => {
        throw new Error('offline');
      },
    }));

    const { listBoxesMerged } = await import('../src/control-plane/list-merged.js');
    const { boxes, hub } = await listBoxesMerged();

    expect(hub).toBeNull();
    expect(boxes.map((b) => b.id)).toEqual(['local-1']);
    // With no listing we have no authority to call anything an orphan.
    expect(boxes[0]?.source).toBe('local');
  });
});
