import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListedBox } from '@agentbox/sandbox-docker';
import type { HubApiBox } from '../src/control-plane/hub-api-client.js';
import { mergeApiBoxes } from '../src/dashboard/box-list.js';

/** A local ListedBox with just the fields the merge reads. */
function local(over: Partial<ListedBox> & { id: string; name: string }): ListedBox {
  return {
    provider: 'docker',
    container: 'agentbox-x',
    image: 'agentbox/box:dev',
    workspacePath: '/w',
    relayToken: 't',
    createdAt: '2026-01-01T00:00:00.000Z',
    state: 'running',
    endpoints: { domain: '', domainIsOrb: false, endpoints: [] },
    shellSessions: [],
    codexSession: null,
    opencodeSession: null,
    ...over,
  } as ListedBox;
}

/** A hub `/api/v1` box row with just the fields the merge reads. */
function hub(over: Partial<HubApiBox> & { id: string }): HubApiBox {
  return {
    task: over.name ?? over.id,
    provider: 'e2b',
    status: 'running',
    branch: '',
    ...over,
  } as HubApiBox;
}

describe('mergeApiBoxes', () => {
  it('leaves every box local when the hub listing is null (unreachable)', () => {
    const boxes = [
      local({ id: 'a', name: 'docker-box' }),
      local({
        id: 'b',
        name: 'cloud-box',
        provider: 'e2b',
        cloud: { backend: 'e2b', sandboxId: 'sb-1' },
      }),
    ];
    const merged = mergeApiBoxes(boxes, null);
    expect(merged.map((b) => b.source)).toEqual(['local', 'local']);
    expect(merged.some((b) => b.source === 'orphan')).toBe(false);
  });

  it('tags an adopted cloud box as hub and keeps the local row (endpoints, sessions)', () => {
    const boxes = [
      local({
        id: 'b',
        name: 'mine',
        provider: 'hetzner',
        cloud: { backend: 'hetzner', sandboxId: 'sb-1' },
        state: 'paused',
        shellSessions: [{ name: 's1' } as never],
      }),
    ];
    const merged = mergeApiBoxes(boxes, [
      hub({ id: 'b', name: 'mine', provider: 'hetzner', sandboxId: 'sb-1' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe('hub');
    expect(merged[0]!.needsAdopt).toBeUndefined();
    // Local detail survives — the hub row must not flatten it.
    expect(merged[0]!.state).toBe('paused');
    expect(merged[0]!.shellSessions).toHaveLength(1);
  });

  it('synthesizes a row for a hub box that is not in local state', () => {
    const merged = mergeApiBoxes(
      [],
      [
        hub({
          id: 'hub-1',
          name: 'from-web-ui',
          provider: 'e2b',
          sandboxId: 'sb-9',
          image: 'tpl-1',
          webPort: 8080,
          publicHost: '1.2.3.4',
          originUrl: 'https://github.com/o/r.git',
          branch: 'agentbox/from-web-ui',
        }),
      ],
    );
    expect(merged).toHaveLength(1);
    const b = merged[0]!;
    expect(b.source).toBe('hub');
    expect(b.needsAdopt).toBe(true);
    expect(b.name).toBe('from-web-ui');
    expect(b.provider).toBe('e2b');
    expect(b.container).toBe('cloud:sb-9');
    expect(b.cloud?.sandboxId).toBe('sb-9');
    expect(b.cloud?.publicHost).toBe('1.2.3.4');
    expect(b.cloud?.workspaceBranch).toBe('agentbox/from-web-ui');
    // Carried so project-scoped views can match it to a local clone.
    expect(b.originUrl).toBe('https://github.com/o/r.git');
  });

  it('prefers displayName over name for a synthesized row label', () => {
    const merged = mergeApiBoxes(
      [],
      [hub({ id: 'h', name: 'raw', displayName: 'Pretty', sandboxId: 'sb' })],
    );
    expect(merged[0]!.name).toBe('Pretty');
  });

  it('dedupes by sandboxId: one row for a box that is both local and in the listing', () => {
    const merged = mergeApiBoxes(
      [
        local({
          id: 'local-id',
          name: 'same',
          provider: 'e2b',
          cloud: { backend: 'e2b', sandboxId: 'sb-1' },
        }),
      ],
      // The hub knows it under a different box id — sandboxId is the join key.
      [hub({ id: 'other-id', name: 'same', sandboxId: 'sb-1' })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe('hub');
    expect(merged[0]!.id).toBe('local-id');
  });

  it('marks a local cloud box the hub does not know as an orphan', () => {
    const merged = mergeApiBoxes(
      [
        local({
          id: 'gone',
          name: 'destroyed-on-hub',
          provider: 'e2b',
          cloud: { backend: 'e2b', sandboxId: 'sb-dead' },
        }),
      ],
      [hub({ id: 'other', name: 'other', sandboxId: 'sb-live' })],
    );
    const orphan = merged.find((b) => b.name === 'destroyed-on-hub');
    expect(orphan?.source).toBe('orphan');
    // Surfaced, never dropped — a leftover the user should see.
    expect(merged).toHaveLength(2);
  });

  it('never calls a local cloud box an orphan on a stale/failed listing', () => {
    // Regression: offline with a hub configured, fetchBoxListing returns
    // `{boxes: [], stale: true}` — an EMPTY list, not null. Treating that as
    // authority for absence marked every cloud box `orphan`. Absence is only
    // meaningful in a listing we actually received.
    const boxes = [
      local({
        id: 'c',
        name: 'my-cloud-box',
        provider: 'e2b',
        cloud: { backend: 'e2b', sandboxId: 'sb-1' },
      }),
    ];
    const merged = mergeApiBoxes(boxes, [], { stale: true });
    expect(merged[0]!.source).toBe('local');
    expect(merged[0]!.source).not.toBe('orphan');
  });

  it('still renders cached hub rows when the listing is stale', () => {
    const merged = mergeApiBoxes([], [hub({ id: 'h1', name: 'cached-box', sandboxId: 'sb-9' })], {
      stale: true,
    });
    expect(merged.map((b) => b.name)).toEqual(['cached-box']);
    expect(merged[0]!.needsAdopt).toBe(true);
  });

  it('never calls a local docker box an orphan (docker never registers on a remote hub)', () => {
    const merged = mergeApiBoxes([local({ id: 'd', name: 'dock' })], []);
    expect(merged[0]!.source).toBe('local');
  });

  it("skips the hub's own docker boxes (its engine, not reachable from this PC)", () => {
    const merged = mergeApiBoxes([], [hub({ id: 'h', name: 'hub-docker', provider: 'docker' })]);
    expect(merged).toEqual([]);
  });
});

describe('listDashboardBoxes', () => {
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

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@agentbox/sandbox-docker');
    vi.doUnmock('../src/control-plane/hub-list.js');
  });

  it('surfaces a hub-only box alongside the local ones (sourced from /api/v1)', async () => {
    vi.doMock('@agentbox/sandbox-docker', () => ({ listBoxes: async () => [localBox] }));
    vi.doMock('../src/control-plane/hub-list.js', () => ({
      fetchBoxListing: async () => ({
        boxes: [
          {
            id: 'hub-1',
            name: 'hub-1',
            task: 'hub-1',
            provider: 'e2b',
            status: 'running',
            branch: '',
            sandboxId: 'sbx_1',
          },
        ],
        stale: false,
      }),
    }));

    const { listDashboardBoxes } = await import('../src/dashboard/box-list.js');
    const boxes = await listDashboardBoxes();

    expect(boxes.map((b) => b.id).sort()).toEqual(['hub-1', 'local-1']);
    expect(boxes.find((b) => b.id === 'hub-1')?.needsAdopt).toBe(true);
    expect(boxes.find((b) => b.id === 'local-1')?.source).toBe('local');
  });

  it('degrades to the local boxes when the hub listing cannot be fetched', async () => {
    vi.doMock('@agentbox/sandbox-docker', () => ({ listBoxes: async () => [localBox] }));
    vi.doMock('../src/control-plane/hub-list.js', () => ({
      fetchBoxListing: async () => {
        throw new Error('offline');
      },
    }));

    const { listDashboardBoxes } = await import('../src/dashboard/box-list.js');
    const boxes = await listDashboardBoxes();

    expect(boxes.map((b) => b.id)).toEqual(['local-1']);
    // With no listing we have no authority to call anything an orphan.
    expect(boxes[0]?.source).toBe('local');
  });
});
