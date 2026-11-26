import { describe, expect, it } from 'vitest';
import {
  CONTRIBUTION_LIMITS,
  contributionRows,
  mergeContribution,
  parseContributionBody,
  toContribution,
  type UsageContribution,
} from '../src/index.js';

const at = (h: number): number => Date.UTC(2026, 10, 20) + h * 3_600_000;
const base: UsageContribution = {
  v: 1,
  machineId: 'pc-1',
  window: { since: '2026-11-20', until: '2026-11-21' },
  tz: 'Europe/Rome',
  intervals: [{ boxId: 'b1', agent: 'claude', provider: 'docker', start: at(9), end: at(10) }],
  tokens: [{ day: '2026-11-20', agent: 'claude', provider: 'docker', boxId: 'b1', tokens: 10 }],
  shipped: [
    {
      day: '2026-11-20',
      boxId: 'b1',
      pushes: 1,
      commits: 2,
      files: 1,
      additions: 3,
      deletions: 0,
      prsMerged: 2,
    },
  ],
  boxes: [{ boxId: 'b1', agent: 'claude', provider: 'docker' }],
  boxRuns: [{ boxId: 'b1', provider: 'docker', start: at(8), end: at(11) }],
};

describe('parseContributionBody', () => {
  it('takes a well-formed body', () => {
    expect(parseContributionBody(JSON.stringify(base))).toEqual(base);
  });

  it('refuses free text, unknown keys, prototype keys, bad ids and oversize bodies', () => {
    const bad: unknown[] = [
      { ...base, note: 'hello' },
      { ...base, boxes: [{ ...base.boxes[0], name: 'my box' }] },
      { ...base, intervals: [{ ...base.intervals[0], boxId: 'has space' }] },
      { ...base, intervals: [{ ...base.intervals[0], agent: 'gpt' }] },
      { ...base, intervals: [{ ...base.intervals[0], end: at(8) }] },
      { ...base, intervals: [{ ...base.intervals[0], boxId: null }] },
      { ...base, tz: 'Mars/Olympus' },
      { ...base, machineId: '../../etc/passwd' },
      { ...base, window: { since: '2024-01-01', until: '2026-01-01' } },
      { ...base, tokens: [{ ...base.tokens[0], day: '2026-02-30' }] },
      { ...base, v: 2 },
    ];
    for (const b of bad)
      expect(() => parseContributionBody(JSON.stringify(b)), JSON.stringify(b)).toThrow();
    expect(() =>
      parseContributionBody(JSON.stringify(base).replace('{', '{"__proto__":{"x":1},')),
    ).toThrow(/forbidden/);
    expect(() => parseContributionBody(' '.repeat(CONTRIBUTION_LIMITS.bytes + 1))).toThrow(/over/);
  });
});

describe('toContribution', () => {
  it('keeps ids and numbers, drops names and projects, and rows outside the days', () => {
    const c = toContribution(
      {
        sessions: [
          {
            sessionId: 's1',
            boxId: 'b1',
            agent: 'claude',
            provider: 'docker',
            turns: [],
            spans: [
              { start: at(9), end: at(10) },
              { start: at(-48), end: at(-47) },
            ],
          },
          {
            sessionId: 'h1',
            boxId: null,
            agent: 'codex',
            provider: 'host',
            turns: [],
            spans: [{ start: at(12), end: at(13) }],
          },
        ],
        tokens: [
          {
            at: at(9),
            agent: 'claude',
            provider: 'docker',
            boxId: 'b1',
            project: 'acme/api',
            tokens: 5,
          },
        ],
        events: [
          {
            type: 'git.push',
            at: at(9),
            boxId: 'b1',
            project: 'acme/api',
            commits: 2,
            files: 1,
            additions: 3,
            deletions: 1,
          },
          {
            type: 'pr.merged',
            at: at(10),
            boxId: 'b1',
            repo: 'acme/api',
            number: 4,
            title: 'secret title',
          },
        ],
        boxes: [
          {
            boxId: 'b1',
            name: 'secret-name',
            project: 'acme/api',
            agent: 'claude',
            provider: 'docker',
            managerId: 'm1',
          },
        ],
        boxRuns: [{ boxId: 'b1', provider: 'docker', start: at(8), end: at(11) }],
      },
      { machineId: 'pc-1', since: '2026-11-20', until: '2026-11-20', tz: 'UTC' },
    );
    const s = JSON.stringify(c);
    for (const x of ['secret', 'acme']) expect(s).not.toContain(x);
    expect(c.intervals).toHaveLength(2);
    expect(c.intervals[1]).toMatchObject({ boxId: null, sessionId: 'h1' });
    expect(c.shipped).toEqual([
      {
        day: '2026-11-20',
        boxId: 'b1',
        pushes: 1,
        commits: 2,
        files: 1,
        additions: 3,
        deletions: 1,
        prsMerged: 1,
      },
    ]);
    expect(c.boxes).toEqual([
      { boxId: 'b1', agent: 'claude', provider: 'docker', managerId: 'm1' },
    ]);
    expect(() => parseContributionBody(s)).not.toThrow();
  });
});

describe('mergeContribution / contributionRows', () => {
  it('a zone change replaces everything; rows past the keep line go', () => {
    const next = { ...base, tz: 'UTC', intervals: [] };
    expect(mergeContribution(base, next, 0)).toEqual(next);
    const older = {
      ...base,
      window: { since: '2026-11-22', until: '2026-11-22' },
      intervals: [],
      tokens: [],
    };
    expect(mergeContribution(base, older, at(48)).tokens).toHaveLength(0);
  });

  it("skips a kind of row the reader holds itself, and lands a day's counts at its noon", () => {
    const none = {
      sessionBoxIds: new Set<string>(),
      sessionIds: new Set<string>(),
      pushBoxIds: new Set<string>(),
      prBoxIds: new Set<string>(),
      runBoxIds: new Set<string>(),
    };
    const rows = contributionRows(base, none, at(-24), at(48));
    expect(rows.sessions).toHaveLength(1);
    expect(rows.events.filter((e) => e.type === 'pr.merged')).toHaveLength(2);
    // Noon in Rome is 11:00 UTC in November.
    expect(rows.tokens[0]!.at).toBe(at(11));
    const b1 = new Set(['b1']);
    const all = contributionRows(
      base,
      { sessionBoxIds: b1, sessionIds: b1, pushBoxIds: b1, prBoxIds: b1, runBoxIds: b1 },
      at(-24),
      at(48),
    );
    expect([all.sessions, all.tokens, all.events, all.boxRuns].every((a) => a.length === 0)).toBe(
      true,
    );
    // The reader holds only the box's merges (a workspace PR sync): its hours still count.
    const prOnly = contributionRows(base, { ...none, prBoxIds: b1 }, at(-24), at(48));
    expect(prOnly.sessions).toHaveLength(1);
    expect(prOnly.events.map((e) => e.type)).toEqual(['git.push']);
  });
});
