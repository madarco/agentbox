import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVITY_TYPES,
  configureActivityBoxContext,
  configureActivityLedger,
  recordBoxPushed,
  SqliteActivityStore,
  type ActivityStore,
} from '@agentbox/relay';
import { ACTIVITY_EVENT_TYPES } from '../app/(dashboard)/api/v1/lib/openapi';
import { activityBoxContext, sweepActivityPrs, withBoxActivity } from '../lib/backend/activity';
import { GET as getActivity } from '../app/(dashboard)/api/v1/activity/route';
import { backgroundSettled } from '../lib/backend/background';
import { measurePushResult } from '../lib/backend/push-measure';
import type { BackendDeps, GhExec, TimelineBoxFact } from '../lib/backend/deps';
import type { HubBackend } from '../lib/boxes/backend-types';

let store: ActivityStore;

const FACT: TimelineBoxFact = {
  id: 'box1',
  name: 'smoke',
  branches: ['agentbox/smoke'],
  agent: 'claude',
  provider: 'docker',
  account: 'claude/work',
  projectRoot: '/nonexistent/agentbox-activity-test',
  projectId: 'p1',
  originUrl: 'git@github.com:acme/storefront.git',
};

function deps(over: Partial<BackendDeps> = {}): BackendDeps {
  return {
    notify: () => {},
    liveBoxIds: async () => new Set(['box1']),
    jobs: async () => [],
    hostname: () => 'laptop',
    machineId: () => 'm-laptop',
    boxFact: async (id: string) => (id === 'box1' ? FACT : undefined),
    ...over,
  };
}

/** The routes the ledger wraps, all succeeding; `destroy` drops the record like the real one. */
/** What git prints for a push of the box's branch from `a1b2c3d` to `e4f5a6b`. */
const PUSHED =
  'To github.com:acme/storefront.git\n   a1b2c3d..e4f5a6b  agentbox/smoke -> agentbox/smoke\n';

function fakeHub(
  onDestroy?: () => void,
  output: { push?: string; land?: string } = {},
): HubBackend {
  const ok = async () => ({ ok: true as const });
  return {
    create: async () => ({ ok: true as const, jobId: 'j42' }),
    start: ok,
    stop: ok,
    pause: ok,
    resume: ok,
    destroy: async () => {
      onDestroy?.();
      return { ok: true as const };
    },
    gitPush: async () => ({ ok: true as const, stdout: '', stderr: output.push ?? PUSHED }),
    gitPushHost: async () => ({ ok: true as const, stdout: '', stderr: output.land ?? '' }),
  } as unknown as HubBackend;
}

beforeEach(async () => {
  store = new SqliteActivityStore(':memory:');
  await store.migrate();
  configureActivityLedger(store);
});

afterEach(async () => {
  configureActivityLedger(null);
  configureActivityBoxContext(null);
  await store.close();
});

describe('the box routes, recorded for a box in no workspace', () => {
  it('records a pause/resume pair with the box context, in order', async () => {
    const d = deps();
    configureActivityBoxContext(activityBoxContext(d));
    const hub = withBoxActivity(fakeHub(), d);
    await hub.pause('box1');
    await backgroundSettled();
    // Rows of one millisecond tie on `at` and break by id, so start the resume
    // in a later millisecond than the pause.
    const pausedAt = Date.parse((await store.list())[0]!.at);
    while (Date.now() <= pausedAt) await new Promise((r) => setImmediate(r));
    await hub.resume('box1', { stamp: { actor: 'manager', managerId: 'm1' } });
    await backgroundSettled();
    const rows = await store.list();
    expect(rows.map((r) => r.type)).toEqual(['box.paused', 'box.resumed']);
    expect(rows[0]).toMatchObject({
      boxId: 'box1',
      boxName: 'smoke',
      provider: 'docker',
      agent: 'claude',
      account: 'claude/work',
      branch: 'agentbox/smoke',
      projectKey: 'github.com/acme/storefront',
      actor: 'human',
    });
    expect(rows[1]?.actor).toBe('manager');
  });

  it('records nothing for a failed op or a create still in flight', async () => {
    const d = deps();
    const failing = {
      ...fakeHub(),
      stop: async () => ({ ok: false as const, error: 'nope' }),
    } as unknown as HubBackend;
    const hub = withBoxActivity(failing, d);
    await hub.stop('box1');
    await hub.start('job:abc');
    await backgroundSettled();
    expect(await store.list()).toEqual([]);
  });

  it('names a destroyed box from the record it read before the destroy', async () => {
    let gone = false;
    const d = deps({ boxFact: async (id) => (id === 'box1' && !gone ? FACT : undefined) });
    configureActivityBoxContext(activityBoxContext(d));
    const hub = withBoxActivity(
      fakeHub(() => (gone = true)),
      d,
    );
    await hub.destroy('box1');
    await backgroundSettled();
    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'box.destroyed', boxName: 'smoke', provider: 'docker' });
  });

  it('records a create under the timeline key, and a host push measured in the box', async () => {
    const d = deps({
      boxPushStat: async () => ({ additions: 5, deletions: 1, commits: 2, filesChanged: 3 }),
    });
    const hub = withBoxActivity(
      fakeHub(undefined, { land: ' * [new branch]      agentbox/smoke -> review/one\n' }),
      d,
    );
    await hub.create({
      agent: 'codex',
      name: 'n1',
      provider: 'hetzner',
      repoUrl: 'https://github.com/acme/x',
    });
    await hub.gitPushHost('box1', { as: 'review/one' });
    await backgroundSettled();
    const rows = await store.list();
    expect(rows.find((r) => r.type === 'box.created')).toMatchObject({
      id: 'job:j42:created',
      jobId: 'j42',
      boxName: 'n1',
      agent: 'codex',
      provider: 'hetzner',
    });
    expect(rows.find((r) => r.type === 'git.push')).toMatchObject({
      boxId: 'box1',
      branch: 'review/one',
      hostOnly: true,
      commits: 2,
      filesChanged: 3,
      additions: 5,
      deletions: 1,
    });
  });
});

describe('GET /api/v1/activity', () => {
  const get = (q: string): Promise<Response> =>
    getActivity(new Request(`http://hub/api/v1/activity${q}`));

  afterEach(() => {
    globalThis.__AGENTBOX_HUB_ACTIVITY = undefined;
  });

  it('answers 503 with no ledger, filters by type, and keeps the newest with order=desc', async () => {
    expect((await get('')).status).toBe(503);
    globalThis.__AGENTBOX_HUB_ACTIVITY = store;
    const hub = withBoxActivity(fakeHub(), deps());
    for (const op of ['pause', 'resume', 'pause', 'resume'] as const) {
      await hub[op]('box1');
      await backgroundSettled();
      await new Promise((r) => setTimeout(r, 2));
    }
    const resumed = (await (await get('?type=box.resumed')).json()) as {
      events: { type: string; at: string }[];
    };
    expect(resumed.events.map((e) => e.type)).toEqual(['box.resumed', 'box.resumed']);
    const all = (await (await get('?limit=2')).json()) as { events: { at: string }[] };
    const newest = (await (await get('?limit=2&order=desc')).json()) as {
      events: { at: string; type: string }[];
      truncated: boolean;
    };
    expect(newest.truncated).toBe(true);
    expect(newest.events.map((e) => e.type)).toEqual(['box.paused', 'box.resumed']);
    expect(newest.events[0]!.at > all.events[1]!.at).toBe(true);
  });

  it('refuses a malformed time, type, order or limit', async () => {
    globalThis.__AGENTBOX_HUB_ACTIVITY = store;
    for (const q of [
      '?since=7',
      '?until=yesterday',
      '?type=box.exploded',
      '?order=up',
      '?limit=0',
    ]) {
      expect((await get(q)).status, q).toBe(400);
    }
    expect((await get('?since=7d&until=2099-01-01')).status).toBe(200);
  });

  it('answers a failing store with the error envelope', async () => {
    globalThis.__AGENTBOX_HUB_ACTIVITY = {
      ...store,
      list: () => Promise.reject(new Error('pg down')),
    } as ActivityStore;
    const res = await get('');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/pg down/);
  });

  it('documents exactly the ledger types', () => {
    expect(ACTIVITY_EVENT_TYPES).toEqual([...ACTIVITY_TYPES]);
  });
});

describe('the PR sweep for boxes outside a workspace', () => {
  it('records the PRs of the branches the ledger knows, once, under the sync keys', async () => {
    await store.append([
      {
        id: 'r1',
        type: 'box.ready',
        // Before the PR below is opened and merged, as a box's work is.
        at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        boxId: 'box1',
        boxName: 'smoke',
        branch: 'agentbox/smoke',
        repoUrl: 'git@github.com:acme/storefront.git',
        projectKey: 'github.com/acme/storefront',
        source: 'live',
      },
    ]);
    const calls: string[][] = [];
    const gh: GhExec = async (args) => {
      calls.push(args);
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify([
          {
            number: 7,
            title: 't',
            url: 'https://github.com/Acme/Storefront/pull/7',
            headRefName: 'agentbox/smoke',
            baseRefName: 'main',
            state: 'MERGED',
            createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
            mergedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
          },
          {
            number: 8,
            title: 'someone else',
            url: 'https://github.com/Acme/Storefront/pull/8',
            headRefName: 'feature/other',
            baseRefName: 'main',
            state: 'OPEN',
          },
        ]),
      };
    };
    expect(await sweepActivityPrs({ ledger: store, gh })).toBe(2);
    expect(calls[0]).toContain('acme/storefront');
    const prs = await store.list({ types: ['pr.opened', 'pr.merged'] });
    expect(prs.map((p) => p.id)).toEqual([
      'pr:Acme/Storefront#7:opened',
      'pr:Acme/Storefront#7:merged',
    ]);
    expect(prs[1]).toMatchObject({ boxId: 'box1', boxName: 'smoke', pr: { number: 7 } });
    // Merged: the branch is done, and gh is not asked again.
    expect(await sweepActivityPrs({ ledger: store, gh })).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('leaves a repo a workspace names to the workspace sync', async () => {
    await store.append([
      {
        id: 'r1',
        type: 'git.push',
        at: new Date().toISOString(),
        boxId: 'box1',
        branch: 'agentbox/smoke',
        repoUrl: 'git@github.com:acme/storefront.git',
        projectKey: 'github.com/acme/storefront',
        source: 'live',
      },
    ]);
    let calls = 0;
    const gh: GhExec = async () => {
      calls += 1;
      return { exitCode: 0, stderr: '', stdout: '[]' };
    };
    await sweepActivityPrs({
      ledger: store,
      gh,
      skipRepos: new Set(['github.com/acme/storefront']),
    });
    expect(calls).toBe(0);
    await sweepActivityPrs({ ledger: store, gh });
    expect(calls).toBe(1);
  });
});

describe('a reopened branch', () => {
  it('is asked about again once work follows its merge', async () => {
    const at = (d: number): string => new Date(Date.now() - d * 3_600_000).toISOString();
    const common = {
      boxId: 'box1',
      branch: 'agentbox/smoke',
      repoUrl: 'git@github.com:acme/storefront.git',
      projectKey: 'github.com/acme/storefront',
      source: 'live' as const,
    };
    await store.append([
      { ...common, id: 'p1', type: 'git.push', at: at(5) },
      {
        ...common,
        id: 'pr:acme/storefront#7:merged',
        type: 'pr.merged',
        at: at(4),
        pr: { repo: 'acme/storefront', number: 7 },
      },
    ]);
    let calls = 0;
    const gh: GhExec = async () => {
      calls += 1;
      return { exitCode: 0, stderr: '', stdout: '[]' };
    };
    await sweepActivityPrs({ ledger: store, gh });
    expect(calls).toBe(0);
    await store.append([{ ...common, id: 'p2', type: 'git.push', at: at(1) }]);
    await sweepActivityPrs({ ledger: store, gh });
    expect(calls).toBe(1);
  });
});

describe('a push through the hub route', () => {
  const FULL = 'e4f5a6b'.padEnd(40, '0');

  it('measures from the old tip git printed, reading nothing before the push', async () => {
    const calls: string[] = [];
    const d = deps({
      boxRefTip: async (_id, ref) => {
        calls.push(`tip ${ref}`);
        return FULL;
      },
      boxPushStat: async (_id, opts) => {
        calls.push(`stat ${opts?.before ?? '-'}`);
        return { additions: 1, deletions: 0, commits: 1, filesChanged: 1 };
      },
    });
    const hub = withBoxActivity(
      {
        ...fakeHub(),
        gitPush: async () => {
          calls.push('push');
          return { ok: true as const, stdout: '', stderr: PUSHED };
        },
      } as HubBackend,
      d,
    );
    await hub.gitPush('box1');
    await backgroundSettled();
    expect(calls).toEqual(['push', 'stat a1b2c3d', 'tip e4f5a6b']);
    const rows = await store.list({ types: ['git.push'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `push:box1:${FULL}`, commits: 1, actor: 'human' });
  });

  it('keeps one row when a direct box also reports the push itself', async () => {
    const d = deps({ boxRefTip: async () => FULL });
    const hub = withBoxActivity(fakeHub(), d);
    await hub.gitPush('box1');
    await backgroundSettled();
    // The relay's row for the box's own report of the same push (`recordBoxPushed`).
    await recordBoxPushed(
      { boxId: 'box1', boxName: 'smoke', hostPath: '' },
      { branch: 'agentbox/smoke', after: FULL },
    );
    // A new ctl marks the report; the relay drops it.
    await recordBoxPushed(
      { boxId: 'box1', boxName: 'smoke', hostPath: '' },
      { branch: 'agentbox/smoke', after: 'f'.repeat(40), hostInitiated: true },
    );
    expect(await store.list({ types: ['git.push'] })).toHaveLength(1);
  });

  it('records no landing when git landed nothing', async () => {
    const hub = withBoxActivity(fakeHub(undefined, { land: '' }), deps());
    await hub.gitPushHost('box1');
    await backgroundSettled();
    expect(await store.list({ types: ['git.push'] })).toHaveLength(0);
  });

  it('measures once for the timeline and the ledger', async () => {
    let stats = 0;
    const d = deps({
      boxPushStat: async () => {
        stats += 1;
        return { additions: 1, deletions: 0, commits: 1, filesChanged: 1 };
      },
    });
    const res = { ok: true as const, stderr: PUSHED };
    const [a, b] = await Promise.all([
      measurePushResult(d, FACT, {}, res),
      measurePushResult(d, FACT, {}, res),
    ]);
    expect(stats).toBe(1);
    expect(a).toBe(b);
  });
});
