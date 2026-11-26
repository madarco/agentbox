import { describe, expect, it } from 'vitest';
import {
  buildLanes,
  changePct,
  feedEntries,
  lastDays,
  runningAtOnce,
  type DashActivity,
  type DashBox,
} from '../lib/dashboard-view';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const at = (hAgo: number) => new Date(NOW - hAgo * 3_600_000).toISOString();
const ev = (id: string, type: string, hAgo: number, extra: Partial<DashActivity> = {}) => ({
  id,
  type,
  at: at(hAgo),
  ...extra,
});
const box = (id: string, status: string, extra: Partial<DashBox> = {}): DashBox => ({
  id,
  name: id,
  task: `task ${id}`,
  agent: 'claude',
  status,
  lastActivity: NOW,
  ...extra,
});

describe('buildLanes', () => {
  it('draws a running box from its ready row to now, with pushes and merges', () => {
    const lanes = buildLanes(
      [
        ev('1', 'box.created', 6, { boxName: 'a' }),
        ev('2', 'box.ready', 5, { boxId: 'a', boxName: 'a' }),
        ev('3', 'git.push', 3, { boxId: 'a', commits: 2 }),
        ev('4', 'pr.merged', 1, { boxId: 'a', pr: { repo: 'o/r', number: 4 } }),
      ],
      [box('a', 'running')],
      NOW,
    );
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.label).toBe('task a');
    expect(lanes[0]!.segs).toEqual([[5, 0, 'running']]);
    expect(lanes[0]!.pushes).toEqual([3]);
    expect(lanes[0]!.merges).toEqual([1]);
  });

  it('opens the window in the state an earlier row left, and splits on pause', () => {
    const lanes = buildLanes(
      [
        ev('1', 'box.ready', 20, { boxId: 'b' }),
        ev('2', 'box.paused', 4, { boxId: 'b' }),
        ev('3', 'box.resumed', 2, { boxId: 'b' }),
        ev('4', 'box.stopped', 1, { boxId: 'b' }),
      ],
      [box('b', 'stopped')],
      NOW,
    );
    expect(lanes[0]!.segs).toEqual([
      [12, 4, 'running'],
      [4, 2, 'paused'],
      [2, 1, 'running'],
    ]);
  });

  it('ends a stretch the ledger left open at the box last activity when the box is not in that state', () => {
    const lanes = buildLanes(
      [ev('1', 'box.ready', 6, { boxId: 'c' })],
      [box('c', 'stopped', { lastActivity: NOW - 3 * 3_600_000 })],
      NOW,
    );
    expect(lanes[0]!.segs).toEqual([[6, 3, 'running']]);
  });

  it('skips a box with nothing in the window and orders newest first', () => {
    const lanes = buildLanes(
      [
        ev('1', 'box.ready', 30, { boxId: 'old' }),
        ev('2', 'box.stopped', 20, { boxId: 'old' }),
        ev('3', 'box.ready', 8, { boxId: 'x' }),
        ev('4', 'box.ready', 2, { boxId: 'y' }),
      ],
      [box('old', 'stopped'), box('x', 'running'), box('y', 'running')],
      NOW,
    );
    expect(lanes.map((l) => l.key)).toEqual(['y', 'x']);
  });

  it('keeps a failed create apart from a later box with the same name', () => {
    const lanes = buildLanes(
      [
        ev('1', 'box.created', 6, { boxName: 'a', jobId: 'j1' }),
        ev('2', 'box.failed', 5.9, { boxName: 'a', jobId: 'j1' }),
        ev('3', 'box.created', 5, { boxName: 'a', jobId: 'j2' }),
        ev('4', 'box.ready', 4, { boxId: 'a', boxName: 'a', jobId: 'j2' }),
      ],
      [box('a', 'running'), box('job:j1', 'error', { name: 'a' })],
      NOW,
    );
    const ok = lanes.find((l) => l.key === 'a')!;
    const bad = lanes.find((l) => l.key === 'job:j1')!;
    expect(ok.failed).toBeUndefined();
    expect(ok.segs).toEqual([[4, 0, 'running']]);
    expect(bad.failed).toBeCloseTo(5.9);
    expect(bad.box?.id).toBe('job:j1');
  });

  it('counts boxes running at once', () => {
    const lanes = buildLanes(
      [ev('1', 'box.ready', 8, { boxId: 'x' }), ev('2', 'box.ready', 2, { boxId: 'y' })],
      [box('x', 'running'), box('y', 'running')],
      NOW,
    );
    const load = runningAtOnce(lanes, 12, 60);
    expect(load).toHaveLength(13);
    expect(load[0]).toBe(0);
    expect(load[12]).toBe(2);
    expect(Math.max(...load)).toBe(2);
  });
});

describe('feedEntries', () => {
  it('words pushes, PRs and lifecycle rows, newest first', () => {
    const f = feedEntries([
      ev('1', 'box.ready', 5, { boxId: 'a', boxName: 'a' }),
      ev('2', 'git.push', 3, { boxName: 'a', branch: 'feat/x', commits: 1, additions: 4, deletions: 1 }),
      ev('3', 'pr.merged', 1, { boxName: 'a', pr: { repo: 'o/r', number: 7 } }),
      ev('4', 'box.unknown', 0.5, { boxName: 'a' }),
    ]);
    expect(f.map((e) => e.text)).toEqual(['Merged o/r#7', 'Pushed 1 commit to feat/x', 'Box ready']);
    expect(f[1]!.additions).toBe(4);
  });
});

describe('lastDays', () => {
  it('fills the week ending today, zeros for missing days', () => {
    const days = lastDays({
      range: { id: '7d', since: '2026-11-20', until: '2026-11-26', today: '2026-11-26', tz: 'UTC' },
      daily: [
        {
          date: '2026-11-26',
          tokens: 10,
          agentHours: 2,
          wallHours: 1,
          boxHours: 2,
          peak: 2,
          avgAtOnce: 2,
          commits: 3,
          prsMerged: 1,
          additions: 5,
          deletions: 2,
          files: 1,
          byAgent: {},
          byProvider: {},
        },
      ],
    });
    expect(days).toHaveLength(7);
    expect(days[0]!.date).toBe('2026-11-20');
    expect(days[6]).toMatchObject({ date: '2026-11-26', label: 'Thu', commits: 3, prs: 1 });
    expect(days[5]!.commits).toBe(0);
  });
});

describe('changePct', () => {
  it('signs the change and declines a zero base', () => {
    expect(changePct(118, 100)).toBe('+18%');
    expect(changePct(96, 100)).toBe('−4%');
    expect(changePct(5, 0)).toBeNull();
  });
});
