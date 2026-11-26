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
const resolveHubApiTarget = vi.fn(() => Promise.resolve(LOCAL));
vi.mock('../src/commands/control-plane.js', () => ({ resolveHubApiTarget }));

import { discoverLocalSkills } from '@agentbox/sandbox-core';
import {
  checkSkillsDrift,
  describeDrift,
  driftFromRows,
  takeNewUnuploadable,
} from '../src/lib/skills/drift.js';

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
      'skills: 4 not in sync with the hub (on this PC only: bar, foo; changed: baz; on the hub only: qux). ' +
        "Boxes get the hub's copy. Run `agentbox skills` to sync.",
    );
  });

  it("leaves out a PC skill that can't be uploaded, and names it once", () => {
    const blocked = { problems: [], findings: [{ rule: 'secret-file', path: '.env', line: 1 }] };
    const ok = { problems: [], findings: [] };
    const d = driftFromRows([
      { name: 'leaky', status: 'local-only', local: blocked },
      { name: 'broken', status: 'differs', local: { problems: ['no description'], findings: [] } },
      { name: 'fine', status: 'local-only', local: ok },
    ]);
    expect(d).toMatchObject({ outOfSync: 1, names: ['fine'], unuploadable: ['broken', 'leaky'] });
    expect(takeNewUnuploadable(d.unuploadable)).toEqual(['broken', 'leaky']);
    expect(describeDrift(d, ['broken', 'leaky'])).toBe(
      'skills: 1 not in sync with the hub (on this PC only: fine). ' +
        "Boxes get the hub's copy. Run `agentbox skills` to sync. " +
        "Also 2 can't be uploaded as is (broken, leaky); see `agentbox skills`.",
    );
    // Announced: the next notice doesn't repeat them, and with nothing else to say
    // there is no notice at all.
    expect(takeNewUnuploadable(d.unuploadable)).toEqual([]);
    const onlyBlocked = driftFromRows([{ name: 'leaky', status: 'local-only', local: blocked }]);
    expect(describeDrift(onlyBlocked, takeNewUnuploadable(onlyBlocked.unuploadable))).toBeNull();
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
    // Generous: the first call pays the cold import of the hub resolver.
    const d = await checkSkillsDrift({ cwd: HOME, timeoutMs: 15_000 });
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

  it('is silent with no skills on this PC', async () => {
    stubHub({ seeded: true, skills: [hubSkill('theirs', 'e'.repeat(64))] });
    const logged: string[] = [];
    expect(await checkSkillsDrift({ cwd: HOME, debug: (l) => logged.push(l) })).toBeNull();
    expect(logged).toEqual([expect.stringContaining('no skills on this PC')]);
  });

  it('hashes from its cache to the same tree hash, and still sees an edit', async () => {
    writeSkill('cached');
    const full = await discoverLocalSkills({ home: HOME, maxBytes: 1e9 });
    const listing = { seeded: true, skills: [hubSkill('cached', full[0]!.treeSha)] };
    stubHub(listing);
    expect((await checkSkillsDrift({ cwd: HOME, timeoutMs: 15_000 }))?.outOfSync).toBe(0);
    // Second run reads hashes from ~/.agentbox/skills-hash-cache.json.
    stubHub(listing);
    expect((await checkSkillsDrift({ cwd: HOME }))?.outOfSync).toBe(0);
    writeSkill('cached', 'Edited, and longer than before.');
    stubHub(listing);
    expect((await checkSkillsDrift({ cwd: HOME }))?.changed).toEqual(['cached']);
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
    expect(logged).toEqual([expect.stringContaining('within 200ms')]);
  });

  it('counts a skill with a secret as unuploadable, also from the hash cache', async () => {
    writeSkill('leaky');
    writeFileSync(join(HOME, '.claude', 'skills', 'leaky', '.env'), 'TOKEN=x\n');
    stubHub({ seeded: true, skills: [] });
    const first = await checkSkillsDrift({ cwd: HOME, timeoutMs: 15_000 });
    expect(first).toMatchObject({ outOfSync: 0, unuploadable: ['leaky'] });
    stubHub({ seeded: true, skills: [] });
    expect(await checkSkillsDrift({ cwd: HOME })).toMatchObject({ unuploadable: ['leaky'] });
  });

  it('reuses an answer within cacheTtlMs, and misses on a local change', async () => {
    writeSkill('mine');
    let fetch = stubHub({ seeded: true, skills: [] });
    expect(
      (await checkSkillsDrift({ cwd: HOME, cacheTtlMs: 60_000, timeoutMs: 15_000 }))?.outOfSync,
    ).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch = stubHub({ seeded: true, skills: [] });
    expect((await checkSkillsDrift({ cwd: HOME, cacheTtlMs: 60_000 }))?.outOfSync).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    writeSkill('another');
    fetch = stubHub({ seeded: true, skills: [] });
    expect((await checkSkillsDrift({ cwd: HOME, cacheTtlMs: 60_000 }))?.outOfSync).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('caches a failure too, so an unreachable hub costs a poll loop once', async () => {
    writeSkill('mine');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    );
    expect(await checkSkillsDrift({ cwd: HOME, cacheTtlMs: 60_000, timeoutMs: 15_000 })).toBeNull();
    const fetch = stubHub({ seeded: true, skills: [] });
    expect(await checkSkillsDrift({ cwd: HOME, cacheTtlMs: 60_000 })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('counts the resolve inside the budget', async () => {
    writeSkill('a');
    resolveHubApiTarget.mockImplementationOnce(() => new Promise(() => undefined));
    const t0 = Date.now();
    expect(await checkSkillsDrift({ cwd: HOME, timeoutMs: 200 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('sends no session header (finding the session shells out to ps)', async () => {
    writeSkill('a');
    const fetch = stubHub({ seeded: true, skills: [] });
    await checkSkillsDrift({ cwd: HOME, timeoutMs: 15_000 });
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).has('x-agentbox-session')).toBe(false);
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
