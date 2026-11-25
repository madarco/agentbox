import { describe, expect, it } from 'vitest';
import {
  fmtBytes,
  summarizeAgentCredentials,
  summarizeSkills,
  type CustodyEntry,
} from '../lib/custody-view';

function entry(path: string, size = 100, updatedAt = '2026-07-27T00:00:00.000Z'): CustodyEntry {
  return { path, size, sha256: 'a'.repeat(64), mode: 0o600, updatedAt };
}

describe('summarizeAgentCredentials', () => {
  it('rolls up the agents scope per agent with count, size and latest mtime', () => {
    const summary = summarizeAgentCredentials([
      entry('agents/claude/.credentials.json', 200, '2026-07-27T00:00:00.000Z'),
      entry('agents/claude/.claude.json', 50, '2026-07-28T12:00:00.000Z'),
      entry('agents/codex/auth.json', 30, '2026-07-25T00:00:00.000Z'),
      entry('boxes/box-1/ssh/id_ed25519', 400), // other scope — ignored
    ]);
    expect(summary.map((a) => a.agent)).toEqual(['claude', 'codex']);
    const claude = summary.find((a) => a.agent === 'claude')!;
    expect(claude.label).toBe('Claude');
    expect(claude.count).toBe(2);
    expect(claude.size).toBe(250);
    expect(claude.lastUpdate).toBe(Date.parse('2026-07-28T12:00:00.000Z'));
  });

  it('falls back to the raw id for an unknown agent and returns [] when empty', () => {
    expect(summarizeAgentCredentials([])).toEqual([]);
    const summary = summarizeAgentCredentials([entry('agents/gemini/creds.json')]);
    expect(summary[0]!.label).toBe('gemini');
  });
});

describe('fmtBytes', () => {
  it('formats bytes, KB, and MB', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(1024 * 1024 * 3)).toBe('3.0 MB');
  });
});

describe('summarizeSkills', () => {
  it('counts skills by meta.json, sums tarballs, and reads the seeded marker', () => {
    expect(
      summarizeSkills([
        entry('skills/.seeded', 40),
        entry('skills/one/meta.json', 500),
        entry(`skills/one/${'a'.repeat(64)}.tar.gz`, 1000),
        entry(`skills/one/${'b'.repeat(64)}.tar.gz`, 2000),
        entry('skills/two/meta.json', 300),
        entry(`skills/two/${'c'.repeat(64)}.tar.gz`, 50),
        entry('agents/claude/.credentials.json', 9),
      ]),
    ).toEqual({ count: 2, size: 3050, seeded: true });
    expect(summarizeSkills([])).toEqual({ count: 0, size: 0, seeded: false });
  });
});
