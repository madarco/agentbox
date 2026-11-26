import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVITY_TYPES,
  configureActivityBoxContext,
  configureActivityLedger,
  SqliteActivityStore,
  type ActivityStore,
} from '@agentbox/relay';
import { ACTIVITY_EVENT_TYPES } from '../app/(dashboard)/api/v1/lib/openapi';
import {
  activityBoxContext,
  listActivity,
  sweepActivityPrs,
  withBoxActivity,
} from '../lib/backend/activity';
import { backgroundSettled } from '../lib/backend/background';
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
function fakeHub(onDestroy?: () => void): HubBackend {
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
    gitPush: async () => ({ ok: true as const, output: '' }),
    gitPushHost: async () => ({ ok: true as const, output: '' }),
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
    const hub = withBoxActivity(fakeHub(), d);
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

describe('reading the ledger', () => {
  it('answers unavailable with no ledger, and filters otherwise', async () => {
    expect(await listActivity({}, null)).toEqual({ ok: false, error: 'unavailable' });
    const hub = withBoxActivity(fakeHub(), deps());
    await hub.pause('box1');
    await hub.resume('box1');
    await backgroundSettled();
    const res = await listActivity({ types: ['box.resumed'] });
    expect(res.ok && res.events.map((e) => e.type)).toEqual(['box.resumed']);
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
        at: new Date().toISOString(),
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
            createdAt: '2026-11-20T10:00:00Z',
            mergedAt: '2026-11-21T10:00:00Z',
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
});
