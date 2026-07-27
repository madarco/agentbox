import { describe, expect, it } from 'vitest';
import {
  CUSTODY_SCOPES,
  custodySubject,
  fmtBytes,
  groupCustody,
  shortSha,
  type CustodyEntry,
} from '../lib/custody-view';

function entry(path: string, size = 100): CustodyEntry {
  return { path, size, sha256: 'a'.repeat(64), mode: 0o600, updatedAt: '2026-07-27T00:00:00.000Z' };
}

describe('custodySubject', () => {
  it('takes the second path segment', () => {
    expect(custodySubject('agents/claude/.credentials.json')).toBe('claude');
    expect(custodySubject('boxes/box-abc/ssh/id_ed25519')).toBe('box-abc');
  });

  it('strips a .json bake suffix for prepared records', () => {
    expect(custodySubject('prepared/hetzner.json')).toBe('hetzner');
  });
});

describe('groupCustody', () => {
  it('returns all four scopes in fixed order, even when empty', () => {
    const groups = groupCustody([]);
    expect(groups.map((g) => g.scope)).toEqual([...CUSTODY_SCOPES]);
    expect(groups.every((g) => g.count === 0 && g.subgroups.length === 0)).toBe(true);
  });

  it('buckets entries by scope then subject with counts and sizes', () => {
    const groups = groupCustody([
      entry('agents/claude/.credentials.json', 200),
      entry('agents/codex/auth.json', 50),
      entry('boxes/box-1/ssh/id_ed25519', 400),
      entry('boxes/box-1/ssh/id_ed25519.pub', 100),
      entry('prepared/hetzner.json', 30),
    ]);
    const agents = groups.find((g) => g.scope === 'agents')!;
    expect(agents.count).toBe(2);
    expect(agents.size).toBe(250);
    expect(agents.subgroups.map((s) => s.key)).toEqual(['claude', 'codex']);

    const boxes = groups.find((g) => g.scope === 'boxes')!;
    expect(boxes.count).toBe(2);
    expect(boxes.size).toBe(500);
    expect(boxes.subgroups).toHaveLength(1);
    expect(boxes.subgroups[0]!.key).toBe('box-1');
    // Entries within a subgroup are sorted by path.
    expect(boxes.subgroups[0]!.entries.map((e) => e.path)).toEqual([
      'boxes/box-1/ssh/id_ed25519',
      'boxes/box-1/ssh/id_ed25519.pub',
    ]);

    const prepared = groups.find((g) => g.scope === 'prepared')!;
    expect(prepared.subgroups[0]!.key).toBe('hetzner');
  });

  it('drops entries with an unknown scope', () => {
    const groups = groupCustody([entry('secrets/root/key'), entry('agents/claude/x')]);
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(1);
  });

  it('sorts subgroups by key', () => {
    const groups = groupCustody([
      entry('projects/zeta/seed/.env'),
      entry('projects/alpha/seed/.env'),
    ]);
    const projects = groups.find((g) => g.scope === 'projects')!;
    expect(projects.subgroups.map((s) => s.key)).toEqual(['alpha', 'zeta']);
  });
});

describe('shortSha', () => {
  it('takes the first 12 hex chars', () => {
    expect(shortSha('0123456789abcdef0123')).toBe('0123456789ab');
  });
});

describe('fmtBytes', () => {
  it('formats bytes, KB, and MB', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(1024 * 1024 * 3)).toBe('3.0 MB');
  });
});
