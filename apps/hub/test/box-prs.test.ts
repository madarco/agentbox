import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceAdd } from './_workspace-input';
import { appendTimelineEvent, readTimeline, type TimelineEvent } from '@agentbox/relay';
import { assertTempHome } from '../../../scripts/test-home.js';
import { createBoxPrLookup, indexTimelinePrs, prForBox } from '../lib/backend/box-prs';
import { createWorkspaceBackend } from '../lib/backend/workspaces';
import type { BackendDeps } from '../lib/backend/deps';
import type { Box } from '../lib/boxes/types';

let seq = 0;
function ev(over: Partial<TimelineEvent> & Pick<TimelineEvent, 'type'>): TimelineEvent {
  seq += 1;
  return {
    id: `id${String(seq).padStart(4, '0')}`,
    at: new Date(Date.UTC(2026, 8, 13, 10, 0, seq)).toISOString(),
    actor: 'github',
    ...over,
  };
}

function prEv(
  type: 'pr.opened' | 'pr.ready' | 'pr.merged' | 'pr.closed',
  number: number,
  head: string,
  over: Partial<TimelineEvent> = {},
): TimelineEvent {
  return ev({
    type,
    branch: head,
    pr: {
      repo: 'o/r',
      number,
      title: `PR ${String(number)}`,
      url: `https://github.com/o/r/pull/${String(number)}`,
      base: 'main',
      head,
    },
    ...over,
  });
}

function box(over: Partial<Box> = {}): Box {
  return { id: 'box1', projectId: 'p1', branch: 'agentbox/one', ...over } as Box;
}

describe('prForBox', () => {
  it('matches by box id before branch', () => {
    const idx = indexTimelinePrs([
      prEv('pr.opened', 10, 'agentbox/one'),
      prEv('pr.opened', 11, 'feature/x', { boxId: 'box1' }),
    ]);
    expect(prForBox(box(), new Map([['w1', idx]]), 'w1')).toEqual({
      repo: 'o/r',
      number: 11,
      url: 'https://github.com/o/r/pull/11',
      state: 'open',
    });
  });

  it('matches a branch only in the box workspace, a box id in any', () => {
    const indexes = new Map([
      ['w1', indexTimelinePrs([prEv('pr.opened', 10, 'agentbox/one')])],
      ['w2', indexTimelinePrs([prEv('pr.merged', 12, 'other', { boxId: 'box2' })])],
    ]);
    expect(prForBox(box(), indexes, 'w2')).toBeUndefined();
    expect(prForBox(box(), indexes, undefined)).toBeUndefined();
    expect(prForBox(box(), indexes, 'w1')?.number).toBe(10);
    expect(prForBox(box({ id: 'box2' }), indexes, 'w1')).toMatchObject({
      number: 12,
      state: 'merged',
    });
  });

  it('matches a worktree branch and a pr.head when the event has no branch', () => {
    const idx = indexTimelinePrs([prEv('pr.opened', 7, 'agentbox/wt', { branch: undefined })]);
    const b = box({ branch: '', gitWorktrees: [{ branch: 'agentbox/wt' }] });
    expect(prForBox(b, new Map([['w1', idx]]), 'w1')?.number).toBe(7);
  });

  it('prefers an open PR over a merged one on a reused branch, else the newest', () => {
    const reused = indexTimelinePrs([
      prEv('pr.opened', 20, 'agentbox/one'),
      prEv('pr.opened', 21, 'agentbox/one'),
      prEv('pr.merged', 20, 'agentbox/one'),
    ]);
    expect(prForBox(box(), new Map([['w', reused]]), 'w')).toMatchObject({
      number: 21,
      state: 'open',
    });
    // An older PR still open wins over a newer one already closed.
    const stale = indexTimelinePrs([
      prEv('pr.opened', 30, 'agentbox/one'),
      prEv('pr.opened', 31, 'agentbox/one'),
      prEv('pr.closed', 31, 'agentbox/one'),
    ]);
    expect(prForBox(box(), new Map([['w', stale]]), 'w')?.number).toBe(30);
    const bothDone = indexTimelinePrs([
      prEv('pr.opened', 40, 'agentbox/one'),
      prEv('pr.merged', 40, 'agentbox/one'),
      prEv('pr.opened', 41, 'agentbox/one'),
      prEv('pr.closed', 41, 'agentbox/one'),
    ]);
    expect(prForBox(box(), new Map([['w', bothDone]]), 'w')).toMatchObject({
      number: 41,
      state: 'closed',
    });
  });

  it('takes the strongest logged state, and the live sync state over it', () => {
    const events = [
      prEv('pr.merged', 50, 'agentbox/one'),
      // Logged after the merge (a sync appends late): the merge still wins.
      prEv('pr.ready', 50, 'agentbox/one'),
      prEv('pr.opened', 50, 'agentbox/one'),
    ];
    expect(indexTimelinePrs(events).byBranch.get('agentbox/one')?.[0]?.state).toBe('merged');
    const ready = indexTimelinePrs([prEv('pr.ready', 51, 'agentbox/one')], () => 'open');
    expect(prForBox(box(), new Map([['w', ready]]), 'w')?.state).toBe('open');
  });
});

describe('createBoxPrLookup', () => {
  const deps: BackendDeps = {
    notify: vi.fn(),
    liveBoxIds: async () => new Set(),
    jobs: async () => [],
  };

  beforeEach(async () => {
    await rm(join(assertTempHome(), '.agentbox'), { recursive: true, force: true });
  });

  async function workspace(): Promise<{ id: string; root: string }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-boxpr-')));
    await mkdir(join(root, '.git'), { recursive: true });
    const added = await createWorkspaceBackend(deps).addWorkspace(await workspaceAdd(root));
    if (!added.ok) throw new Error(added.error);
    return { id: added.workspace.id, root };
  }

  it('reads nothing when no workspace exists', async () => {
    const readEvents = vi.fn(readTimeline);
    const lookup = createBoxPrLookup({ readEvents });
    const prOf = await lookup.resolver(new Map());
    expect(prOf(box())).toBeUndefined();
    expect(readEvents).not.toHaveBeenCalled();
  });

  it('rebuilds a workspace index only when its log or the PR states change', async () => {
    const ws = await workspace();
    const readEvents = vi.fn(readTimeline);
    let version = 0;
    const states = new Map<string, 'open' | 'ready' | 'merged' | 'closed'>();
    const lookup = createBoxPrLookup({
      readEvents,
      sync: {
        prState: (repo, n) => states.get(`${repo}#${String(n)}`),
        statesVersion: () => version,
      },
    });
    const byProject = new Map([['p1', ws.id]]);

    expect((await lookup.resolver(byProject))(box())).toBeUndefined();
    expect(readEvents).not.toHaveBeenCalled();

    await appendTimelineEvent(ws.id, prEv('pr.opened', 412, 'agentbox/one'));
    expect((await lookup.resolver(byProject))(box())).toMatchObject({ number: 412, state: 'open' });
    expect(readEvents).toHaveBeenCalledTimes(1);
    await lookup.resolver(byProject);
    expect(readEvents).toHaveBeenCalledTimes(1);

    states.set('o/r#412', 'ready');
    version += 1;
    expect((await lookup.resolver(byProject))(box())?.state).toBe('ready');
    expect(readEvents).toHaveBeenCalledTimes(2);

    await appendTimelineEvent(ws.id, prEv('pr.merged', 412, 'agentbox/one'));
    states.delete('o/r#412');
    expect((await lookup.resolver(byProject))(box())?.state).toBe('merged');
    expect(readEvents).toHaveBeenCalledTimes(3);

    // Without a projectId match the box is placed by its project root.
    const byRoot = (await lookup.resolver(new Map()))(
      box({ projectId: 'unknown', projectRoot: join(ws.root, 'sub') }),
    );
    expect(byRoot?.number).toBe(412);
  });

  it('never rejects when a log cannot be read', async () => {
    const ws = await workspace();
    await appendTimelineEvent(ws.id, prEv('pr.opened', 1, 'agentbox/one'));
    const lookup = createBoxPrLookup({ readEvents: () => Promise.reject(new Error('EIO')) });
    const prOf = await lookup.resolver(new Map([['p1', ws.id]]));
    expect(prOf(box())).toBeUndefined();
  });
});
