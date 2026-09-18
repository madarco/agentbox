import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { assertTempHome } from '../../../scripts/test-home.js';
import {
  addWorkspace,
  resolveWorkspaceDir,
  timelineFile,
} from '../src/workspaces/workspace-store.js';
import {
  appendTimelineEvent,
  hasTimelineKey,
  newTimelineEventId,
  readTimeline,
  recordTimelineEvent,
  TIMELINE_KEEP_LINES,
  TIMELINE_MAX_LINES,
  TIMELINE_RETENTION_MS,
  readWorkspaceForBox,
} from '../src/workspaces/timeline-store.js';
import type { WorkspaceRecord } from '../src/workspaces/types.js';

const noRegister = { register: async (): Promise<void> => {} };

async function makeWorkspace(): Promise<WorkspaceRecord & { root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-timeline-')));
  const rec = await addWorkspace(
    { host: hostname(), root, projects: [{ path: root, name: 'app', repoUrl: REPO }] },
    noRegister,
  );
  return { ...rec, root };
}

/** The same repo, spelled two ways: both must key one workspace. */
const REPO = 'git@github.com:acme/app.git';
const REPO_HTTPS = 'https://github.com/acme/app';

async function logFile(ws: WorkspaceRecord): Promise<string> {
  return timelineFile((await resolveWorkspaceDir(ws.id))!);
}

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

beforeEach(async () => {
  await rm(join(assertTempHome(), '.agentbox'), { recursive: true, force: true });
});

describe('timeline store', () => {
  it('reads newest first by event time, not by append order', async () => {
    const ws = await makeWorkspace();
    await appendTimelineEvent(ws.id, { type: 'task.created', actor: 'human', at: ago(1000) });
    // A synced merge arrives after, stamped with the earlier time it merged at.
    await appendTimelineEvent(ws.id, { type: 'pr.merged', actor: 'github', at: ago(60_000) });
    await appendTimelineEvent(ws.id, { type: 'git.push', actor: 'box' });
    const events = await readTimeline(ws.id);
    expect(events.map((e) => e.type)).toEqual(['git.push', 'task.created', 'pr.merged']);
    expect(events.every((e) => typeof e.id === 'string' && typeof e.at === 'string')).toBe(true);
  });

  it('pages with before and limit, and filters with since', async () => {
    const ws = await makeWorkspace();
    for (let i = 5; i >= 1; i--) {
      await appendTimelineEvent(ws.id, {
        type: 'manager.note',
        actor: 'manager',
        text: `n${String(i)}`,
        at: ago(i * 60_000),
      });
    }
    const first = await readTimeline(ws.id, { limit: 2 });
    expect(first.map((e) => e.text)).toEqual(['n1', 'n2']);
    const next = await readTimeline(ws.id, { before: first[1]!.at, limit: 2 });
    expect(next.map((e) => e.text)).toEqual(['n3', 'n4']);
    const recent = await readTimeline(ws.id, { since: ago(150_000) });
    expect(recent.map((e) => e.text)).toEqual(['n1', 'n2']);
  });

  it('appends an event whose key is already logged only once', async () => {
    const ws = await makeWorkspace();
    const key = 'pr:o/r#405:merged';
    expect(
      await appendTimelineEvent(ws.id, { type: 'pr.merged', actor: 'box', key }),
    ).not.toBeNull();
    expect(
      await appendTimelineEvent(ws.id, { type: 'pr.merged', actor: 'github', key }),
    ).toBeNull();
    expect(await hasTimelineKey(ws.id, key)).toBe(true);
    expect((await readTimeline(ws.id)).length).toBe(1);
  });

  it('sees a key another process appended since the last read', async () => {
    const ws = await makeWorkspace();
    await appendTimelineEvent(ws.id, { type: 'git.push', actor: 'box' });
    const other = {
      id: newTimelineEventId(),
      at: new Date().toISOString(),
      type: 'pr.opened',
      actor: 'github',
      key: 'pr:o/r#9:opened',
    };
    await appendFile(await logFile(ws), JSON.stringify(other) + '\n');
    expect(await hasTimelineKey(ws.id, 'pr:o/r#9:opened')).toBe(true);
    expect(
      await appendTimelineEvent(ws.id, { type: 'pr.opened', actor: 'box', key: 'pr:o/r#9:opened' }),
    ).toBeNull();
  });

  it('compacts past the line limit down to the newest events', async () => {
    const ws = await makeWorkspace();
    const lines: string[] = [];
    for (let i = 0; i < TIMELINE_MAX_LINES; i++) {
      lines.push(
        JSON.stringify({
          id: newTimelineEventId(Date.now() - (TIMELINE_MAX_LINES - i) * 1000),
          at: ago((TIMELINE_MAX_LINES - i) * 1000),
          type: 'git.push',
          actor: 'box',
          text: String(i),
        }),
      );
    }
    await writeFile(await logFile(ws), lines.join('\n') + '\n');
    await appendTimelineEvent(ws.id, { type: 'manager.note', actor: 'manager', text: 'last' });
    const events = await readTimeline(ws.id);
    expect(events.length).toBe(TIMELINE_KEEP_LINES);
    expect(events[0]!.text).toBe('last');
    expect(events.at(-1)!.text).toBe(String(TIMELINE_MAX_LINES - TIMELINE_KEEP_LINES + 1));
  });

  it('drops events older than the retention window on the next append', async () => {
    const ws = await makeWorkspace();
    await appendTimelineEvent(ws.id, {
      type: 'pr.merged',
      actor: 'github',
      at: ago(TIMELINE_RETENTION_MS + 60_000),
    });
    await appendTimelineEvent(ws.id, { type: 'git.push', actor: 'box' });
    expect((await readTimeline(ws.id)).map((e) => e.type)).toEqual(['git.push']);
  });

  it('keeps every concurrent append, each exactly once', async () => {
    const ws = await makeWorkspace();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        appendTimelineEvent(ws.id, { type: 'git.push', actor: 'box', text: String(i) }),
      ),
    );
    const raw = await readFile(await logFile(ws), 'utf8');
    const parsed = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { text: string; id: string });
    expect(parsed.length).toBe(25);
    expect(new Set(parsed.map((p) => p.text)).size).toBe(25);
    expect(new Set(parsed.map((p) => p.id)).size).toBe(25);
  });

  it('records nothing for an unknown workspace, and never throws', async () => {
    expect(
      await recordTimelineEvent('0123456789abcdef', { type: 'git.push', actor: 'box' }),
    ).toBeNull();
  });

  it('finds the workspace a box belongs to, by folder and by repo', async () => {
    const ws = await makeWorkspace();
    const here = hostname();
    expect(
      (await readWorkspaceForBox({ host: here, projectRoot: join(ws.root, 'app', 'src') }))?.id,
    ).toBe(ws.id);
    expect(await readWorkspaceForBox({ host: here, projectRoot: `${ws.root}-sibling` })).toBeNull();
    // A cloud box: its folder is a literal /workspace, its origin is the key.
    expect(
      (await readWorkspaceForBox({ originUrl: REPO_HTTPS, host: 'box', projectRoot: '/workspace' }))
        ?.id,
    ).toBe(ws.id);
    expect(await readWorkspaceForBox({ originUrl: 'https://github.com/acme/other' })).toBeNull();
  });

  it('mints ids that sort in time order', () => {
    expect(newTimelineEventId(5) < newTimelineEventId(1_900_000_000_000)).toBe(true);
    expect(newTimelineEventId(1_800_000_000_000).length).toBe(newTimelineEventId(1).length);
  });
});
