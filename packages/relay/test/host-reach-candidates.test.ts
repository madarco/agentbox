import { describe, expect, it } from 'vitest';
import { HostReachQueue, type HostReachRoute } from '../src/host-reach.js';
import { hostReachRouteFor } from '../src/checkouts/route.js';

/**
 * Multi-PC Phase 4: a routed action goes to the box's origin PC first, then to
 * another online PC with the repo, and never to a PC outside its candidates.
 * Every test ends in a settled outcome, as in host-reach.test.ts.
 */

const route: HostReachRoute = {
  repoKey: 'github.com/acme/app',
  candidates: [
    { deviceId: 'pc-a', label: 'laptop', folder: '/Users/a/app' },
    { deviceId: 'pc-b', label: 'desk', folder: '/home/b/app' },
  ],
};

/** A queue with pollers already identified and present. */
function setup(devices: Record<string, string>, opts: { graceMs?: number } = {}) {
  let now = 1_000;
  const q = new HostReachQueue({
    graceMs: opts.graceMs ?? 10_000,
    reachTimeoutMs: 100,
    sweepIntervalMs: 10,
    now: () => now,
  });
  for (const [poller, device] of Object.entries(devices)) {
    q.identify(poller, device);
    q.touch(poller);
  }
  return { q, advance: (ms: number) => (now += ms) };
}

describe('HostReachQueue routing', () => {
  it('offers a routed action to the origin PC, with that PC\'s own checkout', async () => {
    const { q } = setup({ pa: 'pc-a', pb: 'pc-b', pz: 'pc-z' });
    const pending = q.request('box1', 'cp.fromHost', { sources: ['x'], dest: '/w' }, { route });
    // pc-z has no checkout of the repo: it is never offered the action.
    expect(await q.poll(5, 'pz')).toEqual([]);
    // pc-b is a candidate but not the current one while the origin is online.
    expect(await q.poll(5, 'pb')).toEqual([]);
    const [action] = await q.poll(5, 'pa');
    expect(action?.route).toEqual({ repoKey: 'github.com/acme/app', folder: '/Users/a/app' });
    q.resolve(action!.id, { exitCode: 0, stdout: 'from a', stderr: '' }, 'pa');
    await expect(pending).resolves.toMatchObject({ kind: 'result', result: { stdout: 'from a' } });
  });

  it('goes to the next PC with the repo when the origin is offline', async () => {
    const { q } = setup({ pb: 'pc-b' });
    const pending = q.request('box1', 'cp.fromHost', {}, { route });
    const [action] = await q.poll(5, 'pb');
    expect(action?.route?.folder).toBe('/home/b/app');
    q.resolve(action!.id, { exitCode: 0, stdout: 'from b', stderr: '' }, 'pb');
    await expect(pending).resolves.toMatchObject({ result: { stdout: 'from b' } });
  });

  it('moves on when the origin declines, and reports why', async () => {
    const { q } = setup({ pa: 'pc-a', pb: 'pc-b' });
    const pending = q.request('box1', 'cp.fromHost', {}, { route });
    const [first] = await q.poll(5, 'pa');
    q.decline(first!.id, 'pa', 'no checkout of github.com/acme/app here');
    const [second] = await q.poll(5, 'pb');
    expect(second?.id).toBe(first!.id);
    q.decline(second!.id, 'pb', 'checkout folder /home/b/app is gone');
    // Every candidate tried: settles at once instead of waiting out the grace.
    await expect(pending).resolves.toEqual({
      kind: 'unreachable',
      reason: 'never-connected',
      tried: [
        {
          deviceId: 'pc-a',
          label: 'laptop',
          reason: 'declined',
          detail: 'no checkout of github.com/acme/app here',
        },
        {
          deviceId: 'pc-b',
          label: 'desk',
          reason: 'declined',
          detail: 'checkout folder /home/b/app is gone',
        },
      ],
    });
  });

  it('times out to the cache with every candidate named offline when none connects', async () => {
    const { q } = setup({ pz: 'pc-z' }, { graceMs: 20 });
    const pending = q.request('box1', 'cp.fromHost', {}, { route });
    expect(await q.poll(5, 'pz')).toEqual([]);
    const out = await pending;
    expect(out).toMatchObject({ kind: 'unreachable', reason: 'never-connected' });
    expect(out.kind === 'unreachable' && out.tried?.map((t) => t.reason)).toEqual([
      'offline',
      'offline',
    ]);
  });

  it('fails over when the origin takes the action and then goes away', async () => {
    const { q, advance } = setup({ pa: 'pc-a', pb: 'pc-b' });
    const pending = q.request('box1', 'cp.fromHost', {}, { route });
    const [taken] = await q.poll(5, 'pa');
    expect(taken).toBeDefined();
    // pc-a stops polling; pc-b keeps polling and picks the action up.
    advance(150);
    const [again] = await q.poll(5, 'pb');
    expect(again?.id).toBe(taken!.id);
    expect(again?.route?.folder).toBe('/home/b/app');
    // A late answer from the machine that went away does not settle it.
    expect(q.resolve(taken!.id, { exitCode: 0, stdout: 'late a', stderr: '' }, 'pa')).toBe(false);
    q.resolve(again!.id, { exitCode: 0, stdout: 'from b', stderr: '' }, 'pb');
    await expect(pending).resolves.toMatchObject({ result: { stdout: 'from b' } });
  });

  it('re-offers to a restarted relay on the same PC instead of skipping that PC', async () => {
    const { q, advance } = setup({ pa: 'pc-a', pb: 'pc-b' });
    const pending = q.request('box1', 'cp.fromHost', {}, { route });
    const [taken] = await q.poll(5, 'pa');
    advance(150);
    // The origin's relay restarted: a new poller id on the same device.
    q.identify('pa2', 'pc-a');
    q.touch('pb');
    const [again] = await q.poll(5, 'pa2');
    expect(again?.id).toBe(taken!.id);
    q.resolve(again!.id, { exitCode: 0, stdout: 'a again', stderr: '' }, 'pa2');
    await expect(pending).resolves.toMatchObject({ result: { stdout: 'a again' } });
  });

  it('never hands a routed action to a poller with no verified device', async () => {
    const { q } = setup({}, { graceMs: 20 });
    const pending = q.request('box1', 'cp.fromHost', {}, { route });
    expect(await q.poll(5, 'anonymous')).toEqual([]);
    await expect(pending).resolves.toMatchObject({ kind: 'unreachable' });
  });

  it('leaves an unrouted action open to any poller (boxes from before Phase 4)', async () => {
    const { q } = setup({ pz: 'pc-z' });
    const pending = q.request('box1', 'cp.fromHost', {});
    const [action] = await q.poll(5, 'pz');
    expect(action?.route).toBeUndefined();
    q.resolve(action!.id, { exitCode: 0, stdout: '', stderr: '' }, 'pz');
    await expect(pending).resolves.toMatchObject({ kind: 'result' });
  });
});

describe('HostReachQueue poller binding', () => {
  it('binds a poller id to the first device that uses it', () => {
    const q = new HostReachQueue();
    expect(q.identify('p1', 'pc-a')).toBe(true);
    expect(q.identify('p1', 'pc-a')).toBe(true);
    // Another device reusing the id is refused, and does not relabel it.
    expect(q.identify('p1', 'pc-b')).toBe(false);
    expect(q.deviceOf('p1')).toBe('pc-a');
  });

  it('a device cannot take another device\'s routed work by reusing its poller id', async () => {
    const { q } = setup({ pa: 'pc-a' });
    const pending = q.request('box1', 'cp.fromHost', {}, { route });
    expect(q.identify('pa', 'pc-z')).toBe(false);
    const [action] = await q.poll(5, 'pa');
    // Still pc-a's poller (the server refuses pc-z's request before polling).
    expect(action?.route?.folder).toBe('/Users/a/app');
    q.resolve(action!.id, { exitCode: 0, stdout: '', stderr: '' }, 'pa');
    await pending;
  });
});

describe('hostReachRouteFor', () => {
  const KEY = 'github.com/acme/app';
  const reg = {
    boxId: 'box1',
    repoKey: KEY,
    originUrl: 'git@github.com:acme/app.git',
    originMachineId: 'pc-a',
    originMachineLabel: 'laptop',
  };
  const checkouts = [
    { repoKey: KEY, machineId: 'pc-a', folder: '/Users/a/app', label: 'laptop', seenAt: '2026-11-20T00:00:00Z' },
    { repoKey: KEY, machineId: 'pc-b', folder: '/home/b/app', label: 'desk', seenAt: '2026-11-21T00:00:00Z' },
    { repoKey: 'github.com/acme/other', machineId: 'pc-c', folder: '/srv/other', label: 'srv', seenAt: '2026-11-22T00:00:00Z' },
  ];

  it('routes a repo-relative copy to the origin, then PCs with the repo', () => {
    const r = hostReachRouteFor(reg, 'cp.fromHost', { sources: ['data.csv'], dest: '/workspace' }, checkouts);
    expect(r).toEqual({
      kind: 'routed',
      route: {
        repoKey: KEY,
        candidates: [
          { deviceId: 'pc-a', label: 'laptop', folder: '/Users/a/app' },
          { deviceId: 'pc-b', label: 'desk', folder: '/home/b/app' },
        ],
      },
    });
  });

  it('routes a host-absolute path, or a copy mixing one in, to the origin only', () => {
    const abs = hostReachRouteFor(reg, 'cp.toHost', { sources: ['/workspace/out'], dest: '/Users/a/Downloads' }, checkouts);
    expect(abs.kind === 'routed' && abs.route.candidates.map((c) => c.deviceId)).toEqual(['pc-a']);
    const mixed = hostReachRouteFor(reg, 'cp.fromHost', { sources: ['data.csv', '/Users/a/.npmrc'], dest: '/workspace' }, checkouts);
    expect(mixed.kind === 'routed' && mixed.route.candidates.map((c) => c.deviceId)).toEqual(['pc-a']);
  });

  it('sends host tools to the origin only', () => {
    const r = hostReachRouteFor(reg, 'tool.exec', { tool: 'gh' }, checkouts);
    expect(r.kind === 'routed' && r.route.candidates).toEqual([{ deviceId: 'pc-a', label: 'laptop' }]);
  });

  it('serves a hub-built box (no origin) from any PC with the repo', () => {
    const hub = { boxId: 'hb', repoKey: KEY };
    const r = hostReachRouteFor(hub, 'cp.fromHost', { sources: ['x'], dest: '/workspace' }, checkouts);
    expect(r.kind === 'routed' && r.route.candidates.map((c) => c.deviceId)).toEqual(['pc-b', 'pc-a']);
  });

  it('leaves a box with neither an origin nor a checkout unrouted', () => {
    expect(hostReachRouteFor({ boxId: 'old' }, 'cp.fromHost', { sources: ['x'], dest: '/w' }, [])).toEqual({
      kind: 'unrouted',
    });
    expect(hostReachRouteFor({ boxId: 'old' }, 'tool.exec', {}, checkouts)).toEqual({ kind: 'unrouted' });
  });
});
