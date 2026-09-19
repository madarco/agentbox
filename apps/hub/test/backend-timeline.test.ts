import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceAdd } from './_workspace-input';
import { assertTempHome } from '../../../scripts/test-home.js';
import { backgroundSettled } from '../lib/backend/background';
import { createManagerBackend } from '../lib/backend/managers';
import { createWorkspaceBackend } from '../lib/backend/workspaces';
import { createTimelineBackend, withBoxTimeline } from '../lib/backend/timeline';
import { recordCreateJobRowTimeline } from '../lib/hub-worker';
import { parseTimelineEvent } from '../app/(dashboard)/api/v1/lib/validate';
import type { BackendDeps, TimelineBoxFact } from '../lib/backend/deps';
import type { HubBackend } from '../lib/boxes/backend-types';
import {
  configureTimelineSink,
  readTimeline,
  type Store,
  type TimelineEventInput,
  type TimelineSink,
} from '@agentbox/relay';

const SESSION = '5edc0ee0-ce9a-4e30-962d-bc630388d8bc';
const OTHER_SESSION = '01a09ad5-8f51-7ec0-b8f4-2daa8be67500';

function deps(boxes: TimelineBoxFact[] = []): BackendDeps {
  return {
    notify: vi.fn(),
    liveBoxIds: async () => new Set(boxes.map((b) => b.id)),
    jobs: async () => [],
    hostname: () => 'laptop',
    boxFacts: async () => boxes,
    boxFact: async (id) => boxes.find((b) => b.id === id),
    pendingApprovalBoxIds: () => [],
  };
}

async function folder(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-hubev-')));
  await mkdir(join(root, '.git'), { recursive: true });
  return root;
}

/** A workspace with one project, as the CLI would register it. */
async function workspace(repoUrl?: string): Promise<{ id: string; root: string }> {
  const root = await folder();
  const backend = createWorkspaceBackend(deps());
  const added = await backend.addWorkspace(
    await workspaceAdd(root, {
      projects: [{ path: join(root, 'storefront'), ...(repoUrl ? { repoUrl } : {}) }],
    }),
  );
  if (!added.ok) throw new Error(added.error);
  return { id: added.workspace.id, root };
}

/** Collects what a writer hands the sink, instead of writing a log. */
function stubSink(): { sink: TimelineSink; rows: { wsId: string; input: TimelineEventInput }[] } {
  const rows: { wsId: string; input: TimelineEventInput }[] = [];
  return {
    rows,
    sink: {
      kind: 'remote',
      record: async (wsId, input) => {
        rows.push({ wsId, input });
        return null;
      },
      workspaceFor: async () => ({ id: 'remote-ws' }),
    },
  };
}

const fakeHub = (): HubBackend =>
  ({
    create: async () => ({ ok: true as const, jobId: 'job1' }),
    start: async () => ({ ok: true as const }),
    stop: async () => ({ ok: true as const }),
    destroy: async () => ({ ok: true as const }),
    gitPush: async () => ({ ok: true as const }),
    gitPushHost: async () => ({ ok: true as const }),
    gitCheckout: async () => ({ ok: true as const }),
    gitNewBranch: async () => ({ ok: true as const }),
  }) as unknown as HubBackend;

beforeEach(async () => {
  await rm(join(assertTempHome(), '.agentbox'), { recursive: true, force: true });
});

afterEach(() => {
  configureTimelineSink(null);
});

describe('recording a forwarded event', () => {
  it('appends it, reports a key it already has, and refuses an unknown workspace', async () => {
    const ws = await workspace();
    const timeline = createTimelineBackend(deps(), { sync: undefined });
    const input: TimelineEventInput = {
      type: 'box.ready',
      actor: 'hub',
      key: 'job:j1:ready',
      boxName: 'smoke',
    };
    const first = await timeline.recordTimelineEvent(ws.id, input);
    expect(first).toMatchObject({ ok: true });
    expect(first && 'event' in first ? first.event?.type : null).toBe('box.ready');

    // The same report again (a retried job) lands no second row.
    const again = await timeline.recordTimelineEvent(ws.id, input);
    expect(again).toEqual({ ok: true });
    expect((await readTimeline(ws.id)).filter((e) => e.type === 'box.ready')).toHaveLength(1);

    expect(await timeline.recordTimelineEvent('ffffffffffffffff', input)).toBeNull();
  });

  it('keeps the time the event happened, so a late forward is ordered by it', async () => {
    const ws = await workspace();
    const timeline = createTimelineBackend(deps(), { sync: undefined });
    const at = '2026-09-01T10:00:00.000Z';
    const res = await timeline.recordTimelineEvent(ws.id, {
      type: 'box.stopped',
      actor: 'box',
      at,
    });
    expect(res && 'event' in res ? res.event?.at : null).toBe(at);
  });
});

describe('the forwarded-event body', () => {
  const base = { type: 'box.ready', actor: 'hub' };

  it('accepts every actor a forwarder may claim, and no other', () => {
    // `human` is one of them: a person acts on the machine that holds the
    // folder, and forwarding is the only way that row reaches the control box.
    for (const actor of ['box', 'hub', 'manager', 'human']) {
      expect(parseTimelineEvent({ ...base, actor }).ok).toBe(true);
    }
    for (const actor of ['github', 'nobody']) {
      const parsed = parseTimelineEvent({ ...base, actor });
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? '' : parsed.message).toContain('actor must be one of');
    }
  });

  it('accepts only a known event type', () => {
    expect(parseTimelineEvent({ ...base, type: 'box.exploded' }).ok).toBe(false);
    expect(parseTimelineEvent({ ...base, type: 'git.push' }).ok).toBe(true);
  });

  it('drops a client id and normalizes the time', () => {
    const parsed = parseTimelineEvent({ ...base, id: 'forged', at: '2026-09-01T10:00:00Z' });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.value).not.toHaveProperty('id');
    expect(parsed.value.at).toBe('2026-09-01T10:00:00.000Z');
  });

  it('checks the shapes it carries', () => {
    expect(parseTimelineEvent({ ...base, taskIds: [1] }).ok).toBe(false);
    expect(parseTimelineEvent({ ...base, task: { id: 'nope', title: 'x' } }).ok).toBe(false);
    expect(parseTimelineEvent({ ...base, pr: { repo: 'o/r' } }).ok).toBe(false);
    const ok = parseTimelineEvent({
      ...base,
      task: { id: 'T-3', title: 'x', to: 'done' },
      taskIds: ['T-3'],
    });
    expect(ok.ok).toBe(true);
  });
});

describe('a hub whose store is elsewhere', () => {
  it('sends its own box rows to the sink instead of its disk', async () => {
    const ws = await workspace();
    const box: TimelineBoxFact = {
      id: 'box1',
      name: 'smoke',
      branches: ['agentbox/smoke'],
      state: 'running',
      projectRoot: join(ws.root, 'storefront'),
      projectId: 'p1',
      host: 'laptop',
    };
    const d = deps([box]);
    const managers = createManagerBackend(d, {
      workspaceView: async () => null,
      sleep: async () => {},
    });
    const { sink, rows } = stubSink();
    configureTimelineSink(sink);
    const hub = withBoxTimeline(fakeHub(), { deps: d, stampFor: managers.timelineStamp });
    await hub.start('box1');
    await backgroundSettled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      wsId: 'remote-ws',
      input: { type: 'box.started', boxId: 'box1', boxName: 'smoke' },
    });
    // Nothing was written here: the store is the sink's, not this disk.
    expect(await readTimeline(ws.id)).toEqual([]);
  });

  it('joins a create by its project folder when no local record lists the project', async () => {
    const d = deps();
    d.projectRoot = async () => '/home/me/work/storefront';
    const managers = createManagerBackend(d, {
      workspaceView: async () => null,
      sleep: async () => {},
    });
    const keys: unknown[] = [];
    configureTimelineSink({
      kind: 'remote',
      record: async () => null,
      workspaceFor: async (key) => {
        keys.push(key);
        return { id: 'remote-ws' };
      },
    });
    const hub = withBoxTimeline(fakeHub(), { deps: d, stampFor: managers.timelineStamp });
    await hub.create({ projectId: 'p1', agent: 'claude', name: 'smoke' } as Parameters<
      HubBackend['create']
    >[0]);
    await backgroundSettled();
    expect(keys[0]).toMatchObject({ host: 'laptop', projectRoot: '/home/me/work/storefront' });
  });

  /**
   * A machine that registered workspaces BEFORE it was pointed at a control box
   * keeps those records on disk, and the same project is in both. Joining
   * against them yields a workspace id the control box never heard of, so the
   * row is posted to a 404 and silently dropped.
   */
  it('ignores a stale local record that lists the same project', async () => {
    const ws = await workspace();
    const projectId = (await createWorkspaceBackend(deps()).listWorkspaces())[0]?.projects[0]?.id;
    expect(projectId).toBeDefined();
    const d = deps();
    d.projectRoot = async () => join(ws.root, 'storefront');
    const managers = createManagerBackend(d, {
      workspaceView: async () => null,
      sleep: async () => {},
    });
    const { sink, rows } = stubSink();
    configureTimelineSink(sink);
    const hub = withBoxTimeline(fakeHub(), { deps: d, stampFor: managers.timelineStamp });
    await hub.create({ projectId, agent: 'claude', name: 'smoke' } as Parameters<
      HubBackend['create']
    >[0]);
    await backgroundSettled();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.wsId).toBe('remote-ws');
    expect(rows[0]?.wsId).not.toBe(ws.id);
  });
});

describe("a manager's turn, reported by the machine that can read it", () => {
  it('is used for a session on another host, and ignored for one here', async () => {
    const root = await folder();
    const d = deps();
    const workspaces = createWorkspaceBackend(d);
    const managers = createManagerBackend(d, {
      workspaceView: (id) => workspaces.getWorkspace(id),
      sessionTurn: async () => ({ turn: 41, prompt: 'from the transcript' }),
      sleep: async () => {},
    });
    const detected = await managers.detectManager({
      agent: 'claude',
      sessionId: SESSION,
      cwd: root,
      host: 'other-pc',
      projects: [{ path: root }],
    });
    if (!detected.ok) throw new Error(detected.error);
    const wsId = detected.workspace.id;
    expect(
      await managers.timelineStamp(
        { agent: 'claude', sessionId: SESSION, turn: 7, prompt: 'from the PC' },
        wsId,
      ),
    ).toMatchObject({ actor: 'manager', turn: 7, prompt: 'from the PC' });

    // The same session reported from THIS host: the transcript wins.
    const here = await managers.detectManager({
      agent: 'claude',
      sessionId: SESSION,
      cwd: root,
      host: 'laptop',
      projects: [{ path: root }],
    });
    if (!here.ok) throw new Error(here.error);
    expect(
      await managers.timelineStamp(
        { agent: 'claude', sessionId: SESSION, turn: 7, prompt: 'from the PC' },
        wsId,
      ),
    ).toMatchObject({ turn: 41, prompt: 'from the transcript' });
  });

  it("stamps a note from the manager that sent it, and drops another session's turn", async () => {
    const { sink, rows } = stubSink();
    // A note's own write IS the mutation, so unlike every other row it fails
    // when the sink answers nothing.
    configureTimelineSink({
      ...sink,
      record: async (wsId, input) => {
        rows.push({ wsId, input });
        return { id: 'ev1', at: new Date().toISOString(), ...input };
      },
    });
    const root = await folder();
    const d = deps();
    const workspaces = createWorkspaceBackend(d);
    const managers = createManagerBackend(d, {
      workspaceView: (id) => workspaces.getWorkspace(id),
      sleep: async () => {},
    });
    const detected = await managers.detectManager({
      agent: 'claude',
      sessionId: SESSION,
      cwd: root,
      host: 'other-pc',
      projects: [{ path: root }],
    });
    if (!detected.ok) throw new Error(detected.error);
    const id = detected.manager.id;

    // The manager's own `agentbox manager note`, from the machine that reads its
    // transcript. Without this the note carried the turn from the last
    // heartbeat, and none at all when that machine's hub was not running.
    const own = await managers.addManagerNote(
      id,
      { text: 'switched to the box branch' },
      { session: { agent: 'claude', sessionId: SESSION, turn: 9, prompt: 'why the switch' } },
    );
    if (!own.ok) throw new Error(own.error);
    expect(rows.at(-1)?.input).toMatchObject({
      type: 'manager.note',
      actor: 'manager',
      managerId: id,
      turn: 9,
      prompt: 'why the switch',
    });

    // Somebody else's session: the note is still the manager's, the turn is not.
    const other = await managers.addManagerNote(
      id,
      { text: 'noted from elsewhere' },
      { session: { agent: 'claude', sessionId: OTHER_SESSION, turn: 99 } },
    );
    if (!other.ok) throw new Error(other.error);
    expect(rows.at(-1)?.input).toMatchObject({ actor: 'manager', managerId: id });
    expect(rows.at(-1)?.input.turn).toBeUndefined();
  });
});

describe('a create job the hub worker finished', () => {
  function store(job: unknown): Store {
    return {
      getCreateJob: async () => job,
      getBox: async () => undefined,
    } as unknown as Store;
  }

  it('records box.ready under the job key, joined by the repo it cloned', async () => {
    const { sink, rows } = stubSink();
    configureTimelineSink(sink);
    await recordCreateJobRowTimeline(
      store({
        id: 'j7',
        status: 'done',
        request: {
          repoUrl: 'git@github.com:acme/storefront.git',
          provider: 'e2b',
          name: 'smoke',
          agent: 'claude',
          branch: 'main',
        },
      }),
      'j7',
      'done',
      { boxId: 'box9' },
    );
    expect(rows[0]).toMatchObject({
      wsId: 'remote-ws',
      input: {
        type: 'box.ready',
        actor: 'hub',
        key: 'job:j7:ready',
        boxId: 'box9',
        boxName: 'smoke',
        agent: 'claude',
        base: 'main',
      },
    });
  });

  it('records box.failed with the reason', async () => {
    const { sink, rows } = stubSink();
    configureTimelineSink(sink);
    await recordCreateJobRowTimeline(
      store({
        id: 'j8',
        status: 'failed',
        request: { repoUrl: 'git@github.com:acme/storefront.git', provider: 'e2b' },
      }),
      'j8',
      'failed',
      { error: 'provider refused' },
    );
    expect(rows[0]?.input).toMatchObject({
      type: 'box.failed',
      key: 'job:j8:failed',
      text: 'provider refused',
    });
  });
});
