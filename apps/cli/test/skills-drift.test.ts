import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The check reads ~/.claude/skills and ~/.agentbox/config.yaml: point HOME at a
// scratch dir before any module computes a state dir.
vi.hoisted(() => {
  const base = process.env.TMPDIR ?? '/tmp';
  process.env.HOME = `${base}/skills-drift-home-${String(process.pid)}-${String(Date.now())}`;
});

const LOCAL = { url: 'http://127.0.0.1:8787', apiKey: 'local-token' };
const resolveHubApiTarget = vi.fn((_url: string | undefined) => Promise.resolve(LOCAL));
vi.mock('../src/commands/control-plane.js', () => ({ resolveHubApiTarget }));

import { discoverLocalSkills } from '@agentbox/sandbox-core';
import { checkSkillsDrift, describeDrift, driftFromRows } from '../src/lib/skills/drift.js';

const HOME = process.env.HOME!;

function writeSkill(name: string, body = 'Body.'): void {
  const dir = join(HOME, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill ${name}\n---\n\n${body}\n`,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function hubSkill(name: string, current: string): Record<string, unknown> {
  return { name, current, updatedAt: new Date(0).toISOString(), versions: [] };
}

function stubHub(listing: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(() => Promise.resolve(json(listing, status)));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

beforeEach(() => {
  rmSync(join(HOME, '.claude'), { recursive: true, force: true });
  rmSync(join(HOME, '.agentbox'), { recursive: true, force: true });
  resolveHubApiTarget.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

describe('describeDrift', () => {
  it('is null when in sync', () => {
    expect(describeDrift(driftFromRows([{ name: 'a', status: 'same' }]))).toBeNull();
  });

  it('names each group and never counts a skipped skill', () => {
    const d = driftFromRows([
      { name: 'foo', status: 'local-only' },
      { name: 'bar', status: 'local-only' },
      { name: 'baz', status: 'differs' },
      { name: 'qux', status: 'hub-only' },
      { name: 'nope', status: 'skipped' },
    ]);
    expect(d.outOfSync).toBe(4);
    expect(d.names).toEqual(['bar', 'baz', 'foo', 'qux']);
    expect(describeDrift(d)).toBe(
      'skills: 4 not in sync with the hub (on this PC only: foo, bar; changed: baz; on the hub only: qux). ' +
        "Boxes get the hub's copy. Run `agentbox skills` to sync.",
    );
  });

  it('caps the names at five and adds +N more', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      name: `s${String(i)}`,
      status: i < 3 ? 'local-only' : 'differs',
    }));
    expect(describeDrift(driftFromRows(rows))).toContain(
      '(on this PC only: s0, s1, s2; changed: s3, s4; +3 more)',
    );
  });
});

describe('checkSkillsDrift', () => {
  it('compares this PC with the hub in one request', async () => {
    writeSkill('same');
    writeSkill('edited');
    writeSkill('mine');
    const local = await discoverLocalSkills({ home: HOME, maxBytes: 1e9 });
    const sha = (n: string): string => local.find((s) => s.name === n)!.treeSha;
    const fetch = stubHub({
      seeded: true,
      skills: [
        hubSkill('same', sha('same')),
        hubSkill('edited', 'f'.repeat(64)),
        hubSkill('theirs', 'e'.repeat(64)),
        hubSkill('ignored', 'd'.repeat(64)),
      ],
      skipped: ['ignored'],
    });
    const d = await checkSkillsDrift({ cwd: HOME });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(d).toMatchObject({
      outOfSync: 3,
      localOnly: ['mine'],
      changed: ['edited'],
      hubOnly: ['theirs'],
    });
  });

  it('is in sync (0) when the hub matches', async () => {
    writeSkill('same');
    const local = await discoverLocalSkills({ home: HOME, maxBytes: 1e9 });
    stubHub({ seeded: true, skills: [hubSkill('same', local[0]!.treeSha)] });
    expect((await checkSkillsDrift({ cwd: HOME }))?.outOfSync).toBe(0);
  });

  it('costs no request with no skills on this PC', async () => {
    const fetch = stubHub({ seeded: true, skills: [] });
    const logged: string[] = [];
    expect(await checkSkillsDrift({ cwd: HOME, debug: (l) => logged.push(l) })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(logged).toEqual([expect.stringContaining('no skills on this PC')]);
  });

  it('is silent, with a debug line, when the hub errors', async () => {
    writeSkill('a');
    stubHub({ error: { code: 'internal', message: 'boom' } }, 500);
    const logged: string[] = [];
    expect(await checkSkillsDrift({ cwd: HOME, debug: (l) => logged.push(l) })).toBeNull();
    expect(logged).toEqual([expect.stringMatching(/^skills notice skipped:/)]);
  });

  it('gives up within its budget when the hub hangs', async () => {
    writeSkill('a');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    const logged: string[] = [];
    const t0 = Date.now();
    expect(
      await checkSkillsDrift({ cwd: HOME, timeoutMs: 200, debug: (l) => logged.push(l) }),
    ).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(logged).toEqual([expect.stringContaining('no answer within 200ms')]);
  });

  it('is off with skills.notice: false', async () => {
    writeSkill('a');
    mkdirSync(join(HOME, '.agentbox'), { recursive: true });
    writeFileSync(join(HOME, '.agentbox', 'config.yaml'), 'skills:\n  notice: false\n');
    const fetch = stubHub({ seeded: true, skills: [] });
    expect(await checkSkillsDrift({ cwd: HOME })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
