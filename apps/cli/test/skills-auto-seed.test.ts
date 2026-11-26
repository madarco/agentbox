import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The seed reads and writes ~/.agentbox (memo, machine-id) and ~/.claude/skills:
// point HOME at a scratch dir before any module computes a state dir.
vi.hoisted(() => {
  const base = process.env.TMPDIR ?? '/tmp';
  process.env.HOME = `${base}/skills-auto-seed-home-${String(process.pid)}-${String(Date.now())}`;
});

const LOCAL = { url: 'http://127.0.0.1:8787', apiKey: 'local-token' };

// The real resolver's shape for this machine's own hub (plain or `hub expose`):
// with no URL it finds the loopback target and its token; an explicit URL is
// looked up as a remote control box, which holds no credential for loopback.
const resolveHubApiTarget = vi.fn((url: string | undefined) =>
  Promise.resolve(url === undefined ? LOCAL : null),
);
vi.mock('../src/commands/control-plane.js', () => ({ resolveHubApiTarget }));

import { autoSeedSkills, rememberSeeded, seededHubs } from '../src/lib/skills/auto-seed.js';

const HOME = process.env.HOME!;
const memoFile = (): string => join(HOME, '.agentbox', 'skills-seeded.json');

function writeSkill(name: string): void {
  const dir = join(HOME, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill ${name}\n---\n\nBody.\n`,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A hub that has never been seeded; `fail` names uploads that fail on the wire. */
function fakeHub(opts: { skipped?: string[]; fail?: string[] } = {}): {
  uploads: string[];
  auth: Set<string>;
  fetch: ReturnType<typeof vi.fn>;
} {
  const uploads: string[] = [];
  const auth = new Set<string>();
  const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    auth.add(new Headers(init?.headers).get('authorization') ?? '');
    if (url.endsWith('/api/v1/health')) return Promise.resolve(json({ apiVersion: 'v1' }));
    if (url.endsWith('/api/v1/skills'))
      return Promise.resolve(json({ seeded: false, skills: [], skipped: opts.skipped ?? [] }));
    const m = /\/api\/v1\/skills\/([^/?]+)$/.exec(url);
    if (m && init?.method === 'PUT') {
      const name = decodeURIComponent(m[1]!);
      if (opts.fail?.includes(name)) return Promise.reject(new Error('socket hang up'));
      uploads.push(name);
      return Promise.resolve(json({ name, version: 'a'.repeat(64), changed: true }));
    }
    return Promise.resolve(json({ error: { code: 'not_found', message: url } }, 404));
  });
  vi.stubGlobal('fetch', fetch);
  return { uploads, auth, fetch };
}

async function seed(): Promise<{ announced: string[]; logged: string[] }> {
  const announced: string[] = [];
  const logged: string[] = [];
  await autoSeedSkills({ announce: (l) => announced.push(l), debug: (l) => logged.push(l) });
  return { announced, logged };
}

beforeEach(() => {
  rmSync(join(HOME, '.claude'), { recursive: true, force: true });
  rmSync(memoFile(), { force: true });
  resolveHubApiTarget.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

describe("autoSeedSkills against this machine's own hub", () => {
  it('seeds through the target it resolved and remembers the hub', async () => {
    writeSkill('alpha');
    writeSkill('beta');
    const hub = fakeHub();
    const { announced, logged } = await seed();

    // The bug: the target's URL was resolved a second time as an explicit URL,
    // which comes back empty for a local hub, so nothing was ever uploaded.
    for (const call of resolveHubApiTarget.mock.calls) expect(call[0]).toBeUndefined();
    expect(hub.uploads.sort()).toEqual(['alpha', 'beta']);
    expect([...hub.auth]).toEqual(['Bearer local-token']);
    expect(announced).toEqual(["seeded the hub's skills library with 2 skill(s) from this PC"]);
    expect(logged).toEqual([]);
    expect(await seededHubs()).toEqual([LOCAL.url]);
  });

  it('logs a failure with its reason, not the terminal, and retries next time', async () => {
    writeSkill('alpha');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8787'))),
    );
    const { announced, logged } = await seed();
    expect(announced).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('skills seed failed against http://127.0.0.1:8787');
    expect(logged[0]).toContain('ECONNREFUSED');
    expect(await seededHubs()).toEqual([]);
  });

  it('logs why when no hub resolves', async () => {
    resolveHubApiTarget.mockResolvedValueOnce(null);
    const { logged } = await seed();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^skills seed skipped: no hub could be resolved/);
  });

  it('retries when every upload failed, and leaves a partial seed to an explicit upload', async () => {
    writeSkill('alpha');
    writeSkill('beta');
    fakeHub({ fail: ['alpha', 'beta'] });
    let r = await seed();
    expect(r.logged.every((l) => l.includes('the next create retries'))).toBe(true);
    expect(await seededHubs()).toEqual([]);

    // Once one upload lands the hub is seeded and won't take the seed again.
    fakeHub({ fail: ['beta'] });
    r = await seed();
    expect(r.logged).toEqual([
      expect.stringContaining('beta failed (upload it with `agentbox skills`)'),
    ]);
    expect(await seededHubs()).toEqual([LOCAL.url]);
  });
});

describe('the seeded-hubs memo', () => {
  it('a PC with no skills costs no round trip and is not remembered, so a later skill seeds', async () => {
    const hub = fakeHub();
    const { logged } = await seed();
    expect(hub.fetch).not.toHaveBeenCalled();
    expect(logged).toEqual([expect.stringContaining('no skills on this PC')]);
    expect(await seededHubs()).toEqual([]);

    writeSkill('gamma');
    await seed();
    expect(hub.uploads).toEqual(['gamma']);
    expect(await seededHubs()).toEqual([LOCAL.url]);
  });

  it('remembers a hub that skips every skill on this PC', async () => {
    writeSkill('alpha');
    const hub = fakeHub({ skipped: ['alpha'] });
    const { announced, logged } = await seed();
    expect(hub.uploads).toEqual([]);
    expect(announced).toEqual([]);
    expect(logged).toEqual([expect.stringContaining('every skill on this PC is skipped')]);
    expect(await seededHubs()).toEqual([LOCAL.url]);
  });

  it("drops an old memo's loopback entries, keeps its remote ones, and converges", async () => {
    writeSkill('delta');
    mkdirSync(join(HOME, '.agentbox'), { recursive: true });
    writeFileSync(
      memoFile(),
      JSON.stringify({ hubs: [LOCAL.url, 'http://localhost:8787', 'https://hub.example.com'] }),
    );
    expect(await seededHubs()).toEqual(['https://hub.example.com']);
    const hub = fakeHub();
    await seed();
    expect(hub.uploads).toEqual(['delta']);
    expect(await seededHubs()).toEqual([LOCAL.url, 'https://hub.example.com']);
  });

  it('skips the hub without a round trip once remembered', async () => {
    writeSkill('alpha');
    await rememberSeeded(LOCAL.url);
    const hub = fakeHub();
    await seed();
    expect(hub.fetch).not.toHaveBeenCalled();
  });
});
