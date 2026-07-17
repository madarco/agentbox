import { describe, expect, it } from 'vitest';
import type { ListedBox } from '@agentbox/sandbox-docker';
import type { BoxRegistration } from '@agentbox/relay';
import { mergeHubBoxes } from '../src/control-plane/hub-merge.js';

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

function reg(over: Partial<BoxRegistration> & { boxId: string; name: string }): BoxRegistration {
  return {
    registeredAt: '2026-01-01T00:00:00.000Z',
    token: 'tok',
    kind: 'cloud',
    ...over,
  } as BoxRegistration;
}

describe('mergeHubBoxes', () => {
  it('leaves every box local when no control box is configured', () => {
    const boxes = [
      local({ id: 'a', name: 'docker-box' }),
      local({ id: 'b', name: 'cloud-box', provider: 'e2b', cloud: { backend: 'e2b', sandboxId: 'sb-1' } }),
    ];
    const merged = mergeHubBoxes(boxes, null);
    expect(merged.map((b) => b.source)).toEqual(['local', 'local']);
    // Without a control box we have no authority to call anything an orphan.
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
    const merged = mergeHubBoxes(boxes, [reg({ boxId: 'b', name: 'mine', backend: 'hetzner', sandboxId: 'sb-1' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe('hub');
    expect(merged[0]!.needsAdopt).toBeUndefined();
    // Local detail survives — the registration must not flatten it.
    expect(merged[0]!.state).toBe('paused');
    expect(merged[0]!.shellSessions).toHaveLength(1);
  });

  it('synthesizes a row for a hub box that is not in local state', () => {
    const merged = mergeHubBoxes(
      [],
      [
        reg({
          boxId: 'hub-1',
          name: 'from-web-ui',
          backend: 'e2b',
          sandboxId: 'sb-9',
          image: 'tpl-1',
          webPort: 8080,
          publicHost: '1.2.3.4',
          originUrl: 'https://github.com/o/r.git',
          worktrees: [{ containerPath: '/workspace', hostMainRepo: '/tmp/x', branch: 'agentbox/from-web-ui' }],
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
    // Carried so project-scoped `list` can match it to a local clone.
    expect(b.originUrl).toBe('https://github.com/o/r.git');
  });

  it('dedupes by sandboxId: one row for a box that is both local and registered', () => {
    const merged = mergeHubBoxes(
      [local({ id: 'local-id', name: 'same', provider: 'e2b', cloud: { backend: 'e2b', sandboxId: 'sb-1' } })],
      // The control box knows it under a different box id — sandboxId is the join key.
      [reg({ boxId: 'other-id', name: 'same', backend: 'e2b', sandboxId: 'sb-1' })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe('hub');
    expect(merged[0]!.id).toBe('local-id');
  });

  it('marks a local cloud box the control box does not know as an orphan', () => {
    const merged = mergeHubBoxes(
      [local({ id: 'gone', name: 'destroyed-on-hub', provider: 'e2b', cloud: { backend: 'e2b', sandboxId: 'sb-dead' } })],
      [reg({ boxId: 'other', name: 'other', backend: 'e2b', sandboxId: 'sb-live' })],
    );
    const orphan = merged.find((b) => b.name === 'destroyed-on-hub');
    expect(orphan?.source).toBe('orphan');
    // Surfaced, never dropped — a leftover the user should see.
    expect(merged).toHaveLength(2);
  });

  it('never calls a local docker box an orphan (docker never registers on the control box)', () => {
    const merged = mergeHubBoxes([local({ id: 'd', name: 'dock' })], []);
    expect(merged[0]!.source).toBe('local');
  });

  it("skips the control box's own docker boxes (not reachable from this PC)", () => {
    const merged = mergeHubBoxes([], [reg({ boxId: 'h', name: 'hub-docker', kind: 'docker' })]);
    expect(merged).toEqual([]);
  });
});
