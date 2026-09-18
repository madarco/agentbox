import { homedir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { pickWorkspace, resolveWorkspaceAndManager } from '../src/lib/workspace-ref.js';
import type { HostSessionHint } from '../src/lib/host-session.js';
import type { HubApiManagerDetect, HubApiWorkspace } from '../src/control-plane/hub-api-client.js';

/** This machine, as the hub records it. Every match here is keyed by it. */
const HERE = 'laptop';

function ws(
  over: Partial<HubApiWorkspace> & { id: string; root: string; on?: string },
): HubApiWorkspace {
  const { root, on, ...rest } = over;
  return {
    name: over.id,
    projects: [],
    hosts: { [on ?? HERE]: { root, projectRoots: {}, seenAt: '' } },
    projectIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...rest,
  };
}

const all = [
  ws({ id: 'w1', root: '/code/store', name: 'store' }),
  ws({ id: 'w2', root: '/code/store/inner', name: 'inner' }),
  ws({ id: 'w3', root: '/code/storefront', name: 'storefront' }),
];

/** A workspace the hub knows, whose folder is on ANOTHER machine. */
const remoteOnly = ws({ id: 'w4', root: '/code/store', name: 'remote', on: 'vps' });

describe('pickWorkspace', () => {
  it('matches an explicit ref by id, then by root, then by unique name', () => {
    expect(pickWorkspace(all, { host: HERE, ref: 'w2', cwd: '/elsewhere' })?.id).toBe('w2');
    expect(pickWorkspace(all, { host: HERE, ref: '/code/storefront', cwd: '/elsewhere' })?.id).toBe(
      'w3',
    );
    expect(
      pickWorkspace(all, { host: HERE, ref: '/code/storefront/', cwd: '/elsewhere' })?.id,
    ).toBe('w3');
    expect(pickWorkspace(all, { host: HERE, ref: 'inner', cwd: '/elsewhere' })?.id).toBe('w2');
  });

  it('refuses an ambiguous name rather than guessing a folder', () => {
    const dupes = [
      ws({ id: 'a', root: '/x/app', name: 'app' }),
      ws({ id: 'b', root: '/y/app', name: 'app' }),
    ];
    expect(pickWorkspace(dupes, { host: HERE, ref: 'app', cwd: '/x/app' })).toBeNull();
  });

  it('prefers the flag over the env var', () => {
    expect(pickWorkspace(all, { host: HERE, ref: 'w1', env: 'w2', cwd: '/elsewhere' })?.id).toBe(
      'w1',
    );
  });

  it('falls back to the env var, then to the cwd containment', () => {
    expect(pickWorkspace(all, { host: HERE, env: 'w3', cwd: '/code/store' })?.id).toBe('w3');
    expect(pickWorkspace(all, { host: HERE, cwd: '/code/store/pkg' })?.id).toBe('w1');
    // The most specific root wins.
    expect(pickWorkspace(all, { host: HERE, cwd: '/code/store/inner/pkg' })?.id).toBe('w2');
    // Segment boundary: /code/storefront is not inside /code/store.
    expect(pickWorkspace(all, { host: HERE, cwd: '/code/storefront/pkg' })?.id).toBe('w3');
  });

  it('is null when nothing matches', () => {
    expect(pickWorkspace(all, { host: HERE, cwd: '/somewhere/else' })).toBeNull();
    expect(pickWorkspace(all, { host: HERE, ref: 'nope', cwd: '/code/store' })).toBeNull();
  });

  it("matches the cwd only against THIS machine's folder mapping", () => {
    // The same path on the hub's machine is not this machine's folder.
    expect(pickWorkspace([remoteOnly], { host: HERE, cwd: '/code/store/pkg' })).toBeNull();
    expect(pickWorkspace([remoteOnly], { host: 'vps', cwd: '/code/store/pkg' })?.id).toBe('w4');
    // Nor does an explicit path ref reach another machine's root.
    expect(pickWorkspace([remoteOnly], { host: HERE, ref: '/code/store', cwd: '/' })).toBeNull();
    // A workspace with no folder here is still addressable by id and by name.
    expect(pickWorkspace([remoteOnly], { host: HERE, ref: 'w4', cwd: '/' })?.id).toBe('w4');
    expect(pickWorkspace([remoteOnly], { host: HERE, ref: 'remote', cwd: '/' })?.id).toBe('w4');
  });
});

describe('resolveWorkspaceAndManager', () => {
  const hint = (cwd: string): HostSessionHint => ({
    agent: 'claude',
    sessionId: '5edc0ee0-ce9a-4e30-962d-bc630388d8bc',
    cwd,
    host: 'laptop',
  });
  // Every seam injected: nothing reads the real env, cwd or ~/.claude.
  function client(detected?: HubApiWorkspace) {
    return {
      listWorkspaces: vi.fn(async () => all),
      // Typed with its body so a test can read what was sent.
      detectManager: vi.fn<
        (body: HubApiManagerDetect) => Promise<{ manager: never; workspace: HubApiWorkspace }>
      >(async () => ({ manager: { id: 'm1' } as never, workspace: detected ?? all[0]! })),
    };
  }

  it('skips detection for an explicit workspace the session does not live in', async () => {
    const c = client();
    const res = await resolveWorkspaceAndManager(
      c,
      'w3',
      { register: true },
      { env: {}, host: HERE, cwd: '/code/storefront', detect: () => hint('/elsewhere/repo') },
    );
    expect(res).toEqual({ workspace: all[2] });
    expect(c.detectManager).not.toHaveBeenCalled();
  });

  it('attaches the manager when the session lives in the explicit workspace', async () => {
    const c = client(all[2]);
    const res = await resolveWorkspaceAndManager(
      c,
      'w3',
      { register: true },
      { env: {}, host: HERE, cwd: '/tmp', detect: () => hint('/code/storefront/pkg') },
    );
    expect(res).toEqual({ workspace: all[2], managerId: 'm1' });
  });

  it('drops a manager the hub keeps in another workspace', async () => {
    const c = client(all[1]);
    const res = await resolveWorkspaceAndManager(
      c,
      undefined,
      { register: true },
      { env: {}, host: HERE, cwd: '/code/store', detect: () => hint('/code/store') },
    );
    expect(c.detectManager).toHaveBeenCalled();
    expect(res).toEqual({ workspace: all[0] });
  });

  // The scan is a readdir plus a `git remote` per subfolder, and the hub reads
  // `projects` only when it has to CREATE a workspace.
  it('sends the folder scan only when no registered workspace contains the cwd', async () => {
    const inside = client();
    await resolveWorkspaceAndManager(
      inside,
      undefined,
      { register: true },
      { env: {}, host: HERE, cwd: '/code/store', detect: () => hint('/code/store/pkg') },
    );
    expect(inside.detectManager.mock.calls[0]?.[0].projects).toBeUndefined();
    // Only the listing the resolution already fetched is read.
    expect(inside.listWorkspaces).toHaveBeenCalledTimes(1);

    const outside = client(ws({ id: 'w9', root: '/new/repo' }));
    await resolveWorkspaceAndManager(
      outside,
      undefined,
      { register: true },
      { env: {}, host: HERE, cwd: '/new/repo', detect: () => hint('/new/repo') },
    );
    expect(outside.detectManager.mock.calls[0]?.[0].projects).toBeDefined();
  });

  it('never scans the home folder or its parents, registered or not', async () => {
    const c = client(ws({ id: 'w9', root: homedir() }));
    await resolveWorkspaceAndManager(
      c,
      undefined,
      { register: true },
      { env: {}, host: HERE, cwd: homedir(), detect: () => hint(homedir()) },
    );
    expect(c.detectManager.mock.calls[0]?.[0].projects).toBeUndefined();
  });

  it('takes the workspace a detect created when none was picked', async () => {
    const created = ws({ id: 'w9', root: '/new/repo' });
    const c = client(created);
    const res = await resolveWorkspaceAndManager(
      c,
      undefined,
      {},
      { env: {}, host: HERE, cwd: '/new/repo', detect: () => hint('/new/repo') },
    );
    expect(res).toEqual({ workspace: created, managerId: 'm1' });
  });
});
