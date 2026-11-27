import { describe, expect, it } from 'vitest';
import { UserFacingError } from '@agentbox/core';
import {
  HetznerApiError,
  type CreateServerRequest,
  type HetznerDatacenter,
  type HetznerLocation,
  type HetznerServer,
  type HetznerServerType,
} from '../src/client.js';
import {
  createWithLocationFailover,
  fetchLocationPlanInputs,
  isCapacityError,
  planLocations,
} from '../src/failover.js';
import { mapHetznerProvisionError } from '../src/preflight.js';

const LOCATIONS: HetznerLocation[] = [
  { id: 1, name: 'fsn1', city: 'Falkenstein', country: 'DE', network_zone: 'eu-central' },
  { id: 2, name: 'nbg1', city: 'Nuremberg', country: 'DE', network_zone: 'eu-central' },
  { id: 3, name: 'hel1', city: 'Helsinki', country: 'FI', network_zone: 'eu-central' },
  { id: 4, name: 'ash', city: 'Ashburn, VA', country: 'US', network_zone: 'us-east' },
  { id: 5, name: 'hil', city: 'Hillsboro, OR', country: 'US', network_zone: 'us-west' },
];

function type(over: Partial<HetznerServerType> & { id: number; name: string }): HetznerServerType {
  return {
    cores: 4,
    memory: 8,
    disk: 80,
    architecture: 'x86',
    prices: [{ location: 'fsn1' }, { location: 'nbg1' }, { location: 'hel1' }],
    ...over,
  };
}

const CATALOG: HetznerServerType[] = [
  type({ id: 22, name: 'cx33' }),
  // Offered everywhere, including the US: what the final error may point at.
  type({
    id: 33,
    name: 'cpx31',
    prices: ['fsn1', 'nbg1', 'hel1', 'ash', 'hil'].map((location) => ({ location })),
  }),
  // Not offered in nbg1.
  type({ id: 44, name: 'ccx23', prices: [{ location: 'fsn1' }, { location: 'hel1' }] }),
];

function dc(location: string, available: number[]): HetznerDatacenter {
  return {
    id: available.length,
    name: `${location}-dc1`,
    location: { name: location },
    server_types: { supported: [22, 33, 44], available },
  };
}

const capacity = (loc: string) =>
  new HetznerApiError(412, 'resource_unavailable', `error during placement (${loc})`);

/**
 * A fake Hetzner API holding real state: a create refused for capacity makes
 * nothing, a successful one adds a server. `full` is the set of locations with
 * no capacity for any type.
 */
function fakeApi(full: string[]) {
  const servers: HetznerServer[] = [];
  const calls: string[] = [];
  return {
    servers,
    calls,
    createServer(req: CreateServerRequest): Promise<{ server: HetznerServer }> {
      const loc = req.location ?? '';
      calls.push(loc);
      if (full.includes(loc)) return Promise.reject(capacity(loc));
      const server = {
        id: 100 + servers.length,
        name: req.name,
        status: 'running',
        created: '2026-11-27T00:00:00Z',
        public_net: { ipv4: { ip: '203.0.113.9', blocked: false }, ipv6: null },
        server_type: { name: req.server_type, cores: 4, memory: 8, disk: 80 },
        image: null,
        labels: { ...(req.labels ?? {}), location: loc },
      } satisfies HetznerServer;
      servers.push(server);
      return Promise.resolve({ server });
    },
  };
}

function run(
  api: ReturnType<typeof fakeApi>,
  opts: {
    location: string;
    pinned?: boolean;
    serverType?: string;
    datacenters?: HetznerDatacenter[];
  },
) {
  const serverType = opts.serverType ?? 'cx33';
  const pinned = opts.pinned === true;
  const plan = planLocations({
    serverType,
    location: opts.location,
    pinned,
    catalog: CATALOG,
    locations: LOCATIONS,
    ...(opts.datacenters ? { datacenters: opts.datacenters } : {}),
  });
  const logs: string[] = [];
  const loads = { count: 0 };
  const promise = createWithLocationFailover({
    serverType,
    location: opts.location,
    pinned,
    catalog: CATALOG,
    loadPlan: () => {
      loads.count++;
      return Promise.resolve({ plan, locations: LOCATIONS });
    },
    onLog: (l) => logs.push(l),
    mapError: (err) => mapHetznerProvisionError(err),
    attempt: (location) =>
      api.createServer({
        name: 'agentbox-box',
        server_type: serverType,
        image: 460328112,
        location,
      }),
  });
  return { plan, logs, loads, promise };
}

describe('planLocations', () => {
  it('starts at the configured location, then the rest of its zone, never another zone', () => {
    const plan = planLocations({
      serverType: 'cpx31',
      location: 'nbg1',
      pinned: false,
      catalog: CATALOG,
      locations: LOCATIONS,
    });
    expect(plan.candidates).toEqual(['nbg1', 'fsn1', 'hel1']);
    expect(plan.zone).toBe('eu-central');
  });

  it('a pinned location is the only candidate', () => {
    const plan = planLocations({
      serverType: 'cx33',
      location: 'fsn1',
      pinned: true,
      catalog: CATALOG,
      locations: LOCATIONS,
    });
    expect(plan.candidates).toEqual(['fsn1']);
  });

  it('skips a location where the type is not offered', () => {
    const plan = planLocations({
      serverType: 'ccx23',
      location: 'fsn1',
      pinned: false,
      catalog: CATALOG,
      locations: LOCATIONS,
    });
    expect(plan.candidates).toEqual(['fsn1', 'hel1']);
    expect(plan.skipped).toEqual([{ location: 'nbg1', reason: 'ccx23 is not offered there' }]);
  });

  it('skips a later location whose datacenters report the type unavailable, never the first', () => {
    const plan = planLocations({
      serverType: 'cx33',
      location: 'fsn1',
      pinned: false,
      catalog: CATALOG,
      locations: LOCATIONS,
      // fsn1 also reports cx33 unavailable, but it is the configured one: tried anyway.
      datacenters: [dc('fsn1', [33]), dc('nbg1', [33]), dc('hel1', [22, 33])],
    });
    expect(plan.candidates).toEqual(['fsn1', 'hel1']);
    expect(plan.skipped.map((s) => s.location)).toEqual(['nbg1']);
  });

  it('without the location list (lookup failed) there is no failover', () => {
    const plan = planLocations({
      serverType: 'cx33',
      location: 'fsn1',
      pinned: false,
      catalog: CATALOG,
      locations: [],
    });
    expect(plan.candidates).toEqual(['fsn1']);
  });
});

describe('createWithLocationFailover', () => {
  it('no capacity in the first location: lands in the second and logs the move', async () => {
    const api = fakeApi(['fsn1']);
    const { promise, logs } = run(api, { location: 'fsn1' });
    const out = await promise;
    expect(out.location).toBe('nbg1');
    expect(out.tried).toEqual(['fsn1', 'nbg1']);
    expect(api.calls).toEqual(['fsn1', 'nbg1']);
    expect(logs).toContain('hetzner: no cx33 capacity in fsn1, trying nbg1');
    // Exactly one server exists: the refused attempt created nothing.
    expect(api.servers).toHaveLength(1);
    expect(api.servers[0]?.labels.location).toBe('nbg1');
  });

  it('every location full: the error lists them, suggests --size, and none of the tried ones', async () => {
    const api = fakeApi(['fsn1', 'nbg1', 'hel1']);
    const { promise } = run(api, { location: 'fsn1', serverType: 'cpx31' });
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    const msg = (err as Error).message;
    expect(msg).toContain('fsn1, nbg1, hel1');
    expect(msg).toContain('--size');
    expect(msg).toContain('box.sizeHetzner');
    expect(msg).toContain('box.hetznerLocation');
    // Points at the other-zone locations where the type exists, not a tried one.
    expect(msg).toContain('(ash, hil)');
    expect(msg).not.toMatch(/--location (fsn1|nbg1|hel1)/);
    expect(api.servers).toHaveLength(0);
  });

  it('cx33 (EU-only) exhausted: no location outside the zone is suggested', async () => {
    const api = fakeApi(['fsn1', 'nbg1', 'hel1']);
    const err = await run(api, { location: 'nbg1' }).promise.catch((e: unknown) => e);
    const msg = (err as Error).message;
    expect(msg).toContain('nbg1, fsn1, hel1');
    expect(msg).not.toContain('outside the ones tried');
  });

  it('an explicit --location pin does not move', async () => {
    const api = fakeApi(['fsn1']);
    const err = await run(api, { location: 'fsn1', pinned: true }).promise.catch((e: unknown) => e);
    expect(api.calls).toEqual(['fsn1']);
    expect(api.servers).toHaveLength(0);
    const msg = (err as Error).message;
    expect(msg).toContain('pins the box there');
    expect(msg).toContain('--size');
    expect(msg).not.toMatch(/pin a different one \([^)]*fsn1/);
  });

  it('a type not offered in a candidate location is never attempted there', async () => {
    const api = fakeApi(['fsn1']);
    const out = await run(api, { location: 'fsn1', serverType: 'ccx23' }).promise;
    expect(api.calls).toEqual(['fsn1', 'hel1']);
    expect(out.location).toBe('hel1');
  });

  it('a non-capacity error stops at once and is mapped', async () => {
    const api = {
      calls: [] as string[],
      servers: [] as HetznerServer[],
      createServer(req: CreateServerRequest) {
        this.calls.push(req.location ?? '');
        return Promise.reject(new HetznerApiError(403, 'resource_limit_exceeded', 'limit'));
      },
    };
    const err = await run(api as unknown as ReturnType<typeof fakeApi>, {
      location: 'fsn1',
    }).promise.catch((e: unknown) => e);
    expect(api.calls).toEqual(['fsn1']);
    expect((err as Error).message).toMatch(/resource limit/);
  });
});

describe('fetchLocationPlanInputs', () => {
  it('swallows lookup failures', async () => {
    let called = 0;
    const c = {
      listLocations: () => {
        called++;
        return Promise.reject(new Error('boom'));
      },
      listDatacenters: () => {
        called++;
        return Promise.resolve([] as HetznerDatacenter[]);
      },
    };
    expect(await fetchLocationPlanInputs(c)).toEqual({ locations: [], datacenters: [] });
    expect(called).toBe(2);
  });
});

it('isCapacityError matches both capacity codes only', () => {
  expect(isCapacityError(capacity('fsn1'))).toBe(true);
  expect(isCapacityError(new HetznerApiError(409, 'placement_error', 'x'))).toBe(true);
  expect(isCapacityError(new HetznerApiError(403, 'resource_limit_exceeded', 'x'))).toBe(false);
  expect(isCapacityError(new Error('x'))).toBe(false);
});

describe('failover only costs anything after a refusal', () => {
  it('a first-try success loads no plan and logs no skip', async () => {
    const api = fakeApi([]);
    const { promise, logs, loads } = run(api, {
      location: 'fsn1',
      datacenters: [dc('fsn1', [22]), dc('nbg1', [33]), dc('hel1', [33])],
    });
    expect((await promise).location).toBe('fsn1');
    expect(loads.count).toBe(0);
    expect(logs).toEqual([]);
  });

  it('a pinned refusal never loads the plan', async () => {
    const api = fakeApi(['fsn1']);
    const { promise, loads } = run(api, { location: 'fsn1', pinned: true });
    await promise.catch(() => undefined);
    expect(loads.count).toBe(0);
  });

  it('a skipped same-zone location is not offered as another zone in the error', async () => {
    const api = fakeApi(['fsn1', 'hel1']);
    const { promise, logs } = run(api, {
      location: 'fsn1',
      serverType: 'cpx31',
      datacenters: [dc('fsn1', [33]), dc('nbg1', [22]), dc('hel1', [33])],
    });
    const msg = ((await promise.catch((e: unknown) => e)) as Error).message;
    expect(logs).toContain('hetzner: skipping nbg1: Hetzner reports no cpx31 capacity there');
    expect(msg).toContain('fsn1, hel1');
    expect(msg).toContain('(ash, hil)');
    expect(msg).not.toMatch(/\(.*nbg1.*\)/);
  });

  it('without the location list the error makes no zone claim', async () => {
    const api = fakeApi(['nbg1']);
    const err = await createWithLocationFailover({
      serverType: 'cpx31',
      location: 'nbg1',
      pinned: false,
      catalog: CATALOG,
      loadPlan: () =>
        Promise.resolve({
          plan: planLocations({
            serverType: 'cpx31',
            location: 'nbg1',
            pinned: false,
            catalog: CATALOG,
            locations: [],
          }),
          locations: [],
        }),
      onLog: () => {},
      mapError: (e) => e,
      attempt: (location) =>
        api.createServer({ name: 'b', server_type: 'cpx31', image: 1, location }),
    }).catch((e: unknown) => e);
    const msg = (err as Error).message;
    expect(msg).not.toContain('latency');
    expect(msg).toContain('nbg1');
  });
});
