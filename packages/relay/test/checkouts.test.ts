import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyCheckoutReport, listCheckouts } from '../src/checkouts/store.js';
import {
  candidateBoxFromRegistration,
  hostCandidatesFor,
  type CandidateBox,
} from '../src/checkouts/resolve.js';
import type { CheckoutRecord } from '../src/checkouts/types.js';
import { cpCacheKey, cpCachePrefixes } from '../src/cp-cache.js';
import { mergeRegistrationOrigin } from '../src/registration-origin.js';

const KEY = 'github.com/acme/app';
// Relative to now: listings drop rows older than CHECKOUT_MAX_AGE_MS.
const DAY0 = Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
);
const daysAgo = (n: number) => new Date(DAY0 - n * 86_400_000).toISOString();

function co(machineId: string, folder: string, seenAt: string, repoKey = KEY): CheckoutRecord {
  return { repoKey, machineId, folder, label: machineId, seenAt };
}

const box: CandidateBox = {
  boxId: 'box1',
  originMachineId: 'pc-a',
  repos: [{ path: '/workspace', repoKey: KEY, originFolder: '/Users/a/app' }],
};

const checkouts = [
  co('pc-a', '/Users/a/app', '2026-11-20T00:00:00Z'),
  co('pc-b', '/home/b/src/app', '2026-11-21T00:00:00Z'),
  co('pc-c', '/srv/app', '2026-11-22T00:00:00Z'),
  co('pc-d', '/srv/other', '2026-11-22T00:00:00Z', 'github.com/acme/other'),
];

const all = () => true;

describe('hostCandidatesFor', () => {
  it('tries the origin first, then other machines with the repo, newest first', () => {
    const r = hostCandidatesFor(box, './data.csv', checkouts, all);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.relPath).toBe('data.csv');
    expect(r.candidates).toEqual([
      { machineId: 'pc-a', folder: '/Users/a/app', reason: 'origin' },
      { machineId: 'pc-c', folder: '/srv/app', reason: 'has-repo' },
      { machineId: 'pc-b', folder: '/home/b/src/app', reason: 'has-repo' },
    ]);
    // Same key a capture writes today: `rel:data.csv` under the repo's slug.
    expect(r.cacheKey).toEqual({
      prefix: 'projects/github.com__acme__app/cp',
      readPrefixes: ['projects/github.com__acme__app/cp'],
      key: cpCacheKey('data.csv'),
    });
  });

  it('falls through to another machine with the repo when the origin is offline', () => {
    const r = hostCandidatesFor(box, 'data.csv', checkouts, (m) => m === 'pc-b');
    expect(r.ok && r.candidates).toEqual([
      { machineId: 'pc-b', folder: '/home/b/src/app', reason: 'has-repo' },
    ]);
  });

  it('leaves only the cache when no machine with a checkout is online', () => {
    const r = hostCandidatesFor(box, 'data.csv', checkouts, () => false);
    expect(r.ok && r.candidates).toEqual([]);
    expect(r.ok && r.cacheKey.prefix).toBe('projects/github.com__acme__app/cp');
  });

  it('serves a path outside the repo from the origin only', () => {
    const abs = hostCandidatesFor(box, '/Users/a/Downloads/q3.csv', checkouts, all);
    expect(abs.ok && abs.repo).toBeUndefined();
    expect(abs.ok && abs.candidates).toEqual([{ machineId: 'pc-a', reason: 'origin' }]);
    expect(abs.ok && abs.cacheKey.key).toBe(cpCacheKey('/Users/a/Downloads/q3.csv'));
    // Filed where a live capture writes it: the root repo's prefix.
    expect(abs.ok && abs.cacheKey.prefix).toBe('projects/github.com__acme__app/cp');
    // Climbing out of the project is the same thing.
    const up = hostCandidatesFor(box, '../sibling/x', checkouts, all);
    expect(up.ok && up.candidates.map((c) => c.machineId)).toEqual(['pc-a']);
  });

  it('accepts a /workspace path and resolves it against the repo', () => {
    const r = hostCandidatesFor(box, '/workspace/src/a.ts', checkouts, all);
    expect(r.ok && r.relPath).toBe('src/a.ts');
    // Keyed as today's capture spells it, so existing entries still hit.
    expect(r.ok && r.cacheKey.key).toBe(cpCacheKey('/workspace/src/a.ts'));
  });

  it('picks the nested repo by longest prefix, keyed relative to its own root', () => {
    const multi: CandidateBox = {
      boxId: 'box2',
      originMachineId: 'pc-a',
      repos: [
        { path: '/workspace', repoKey: KEY },
        { path: '/workspace/web', repoKey: 'github.com/acme/other' },
      ],
    };
    const r = hostCandidatesFor(multi, 'web/index.html', checkouts, all);
    expect(r.ok && r.repo?.path).toBe('/workspace/web');
    expect(r.ok && r.relPath).toBe('index.html');
    expect(r.ok && r.candidates.map((c) => c.machineId)).toEqual(['pc-a', 'pc-d']);
    expect(r.ok && r.cacheKey.prefix).toBe('projects/github.com__acme__other/cp');
  });

  it('never asks another machine for a repo with no key', () => {
    const local: CandidateBox = {
      boxId: 'box3',
      originMachineId: 'pc-a',
      repos: [{ path: '/workspace' }],
    };
    const r = hostCandidatesFor(local, 'x', checkouts, all);
    expect(r.ok && r.candidates).toEqual([{ machineId: 'pc-a', reason: 'origin' }]);
    expect(r.ok && r.cacheKey.prefix).toBe('boxes/box3/cp');
  });

  it('rejects a relative path in a repo-less box, and answers origin-or-cache otherwise', () => {
    const repoless: CandidateBox = { boxId: 'bot', originMachineId: 'pc-a', repos: [] };
    const rel = hostCandidatesFor(repoless, 'data.csv', checkouts, all);
    expect(rel.ok).toBe(false);
    const abs = hostCandidatesFor(repoless, '/Users/a/.npmrc', checkouts, all);
    expect(abs.ok && abs.candidates).toEqual([{ machineId: 'pc-a', reason: 'origin' }]);
    expect(abs.ok && abs.cacheKey.prefix).toBe('boxes/bot/cp');
  });

  it('has no origin candidate for a hub-built box', () => {
    const hubBuilt = candidateBoxFromRegistration({
      boxId: 'hb',
      repoKey: KEY,
      worktrees: [
        { containerPath: '/workspace', hostMainRepo: '/tmp/agentbox-hub-worker-1', branch: 'b' },
      ],
    });
    const r = hostCandidatesFor(hubBuilt, 'data.csv', checkouts, all);
    expect(r.ok && r.candidates.every((c) => c.reason === 'has-repo')).toBe(true);
  });

  it('derives the key of a registration made before repoKey existed', () => {
    const b = candidateBoxFromRegistration({
      boxId: 'old',
      originUrl: 'git@github.com:Acme/App.git',
    });
    expect(b.repos[0]!.repoKey).toBe(KEY);
    const prefix = hostCandidatesFor(b, '/abs/x', [], all);
    expect(prefix.ok && prefix.cacheKey.readPrefixes).toEqual(
      cpCachePrefixes({ boxId: 'old', originUrl: 'git@github.com:Acme/App.git' }),
    );
    // ...which reaches the legacy owner__repo entries written before the key.
    expect(prefix.ok && prefix.cacheKey.readPrefixes).toContain('projects/Acme__App/cp');
  });

  it('uses the origin folder from the registration when the origin never reported', () => {
    const b = candidateBoxFromRegistration({
      boxId: 'b',
      repoKey: KEY,
      originMachineId: 'pc-z',
      worktrees: [{ containerPath: '/workspace', hostMainRepo: '/Users/z/app', branch: 'b' }],
    });
    const r = hostCandidatesFor(b, 'data.csv', [], all);
    expect(r.ok && r.candidates).toEqual([
      { machineId: 'pc-z', folder: '/Users/z/app', reason: 'origin' },
    ]);
  });
});

describe('checkouts store', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkouts-'));
    file = join(dir, 'checkouts.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps two machines with one repo at different folders under one key', async () => {
    await applyCheckoutReport(
      { machineId: 'pc-a', label: 'a', entries: [{ repoKey: KEY, folder: '/Users/a/app' }] },
      { file },
    );
    await applyCheckoutReport(
      { machineId: 'pc-b', label: 'b', entries: [{ repoKey: KEY, folder: '/home/b/app' }] },
      { file },
    );
    const rows = await listCheckouts({ repoKey: KEY }, file);
    expect(rows.map((r) => [r.machineId, r.folder]).sort()).toEqual([
      ['pc-a', '/Users/a/app'],
      ['pc-b', '/home/b/app'],
    ]);
  });

  it('is idempotent, refreshes seenAt, and removes only the reporter’s own rows', async () => {
    const t = (iso: string) => () => new Date(iso);
    await applyCheckoutReport(
      { machineId: 'pc-a', label: 'a', entries: [{ repoKey: KEY, folder: '/x' }] },
      { file, now: t(daysAgo(2)) },
    );
    await applyCheckoutReport(
      { machineId: 'pc-b', label: 'b', entries: [{ repoKey: KEY, folder: '/x' }] },
      { file },
    );
    await applyCheckoutReport(
      {
        machineId: 'pc-a',
        label: 'a2',
        entries: [
          { repoKey: KEY, folder: '/x', head: 'main' },
          { repoKey: KEY, folder: '/x' },
        ],
      },
      { file, now: t(daysAgo(1)) },
    );
    let mine = await listCheckouts({ machineId: 'pc-a' }, file);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.seenAt).toBe(daysAgo(1));
    expect(mine[0]!.label).toBe('a2');

    await applyCheckoutReport(
      { machineId: 'pc-a', label: 'a', entries: [], removed: [{ repoKey: KEY, folder: '/x' }] },
      { file },
    );
    mine = await listCheckouts({ machineId: 'pc-a' }, file);
    expect(mine).toHaveLength(0);
    expect(await listCheckouts({ machineId: 'pc-b' }, file)).toHaveLength(1);
  });

  it('reads a missing file as empty', async () => {
    expect(await listCheckouts({}, file)).toEqual([]);
  });

  it('refuses to list a corrupt file, and moves it aside before a write', async () => {
    await writeFile(file, '{not json');
    await expect(listCheckouts({}, file)).rejects.toThrow(/not valid JSON/);
    await applyCheckoutReport(
      { machineId: 'pc-a', label: 'a', entries: [{ repoKey: KEY, folder: '/x' }] },
      { file },
    );
    expect(await listCheckouts({}, file)).toHaveLength(1);
    const kept = (await readdir(dir)).filter((n) => n.includes('.corrupt-'));
    expect(kept).toHaveLength(1);
    expect(await readFile(join(dir, kept[0]!), 'utf8')).toBe('{not json');
  });

  it('never overwrites a registry it cannot read', async () => {
    await mkdir(file); // EISDIR: exists, unreadable as a file
    await expect(
      applyCheckoutReport(
        { machineId: 'pc-a', label: 'a', entries: [{ repoKey: KEY, folder: '/x' }] },
        { file },
      ),
    ).rejects.toThrow(/cannot read/);
  });

  it('ages out rows no report has named for 90 days', async () => {
    await applyCheckoutReport(
      { machineId: 'gone', label: 'g', entries: [{ repoKey: KEY, folder: '/old' }] },
      { file, now: () => new Date('2026-01-01T00:00:00Z') },
    );
    await applyCheckoutReport(
      { machineId: 'pc-a', label: 'a', entries: [{ repoKey: KEY, folder: '/x' }] },
      { file, now: () => new Date('2026-06-01T00:00:00Z') },
    );
    const raw = JSON.parse(await readFile(file, 'utf8')) as { checkouts: unknown[] };
    expect(raw.checkouts).toHaveLength(1);
  });
});

describe('mergeRegistrationOrigin', () => {
  it('keeps the first origin machine across re-registers from elsewhere', () => {
    const first = mergeRegistrationOrigin(
      { repoKey: KEY, originMachineId: 'pc-a', originMachineLabel: 'a' },
      undefined,
    );
    expect(first).toEqual({ repoKey: KEY, originMachineId: 'pc-a', originMachineLabel: 'a' });
    const fromB = mergeRegistrationOrigin(
      { repoKey: KEY, originMachineId: 'pc-b', originMachineLabel: 'b' },
      first,
    );
    expect(fromB.originMachineId).toBe('pc-a');
    expect(fromB.originMachineLabel).toBe('a');
  });

  it('keeps everything on a re-register that sends no origin', () => {
    const prior = { repoKey: KEY, originMachineId: 'pc-a', originMachineLabel: 'a' };
    expect(mergeRegistrationOrigin({}, prior)).toEqual(prior);
    expect(mergeRegistrationOrigin({}, undefined)).toEqual({});
  });
});

describe('cpCachePrefixes', () => {
  it('writes under the repo-key slug and still reads the legacy owner__repo one', () => {
    expect(cpCachePrefixes({ boxId: 'b', originUrl: 'git@github.com:Acme/App.git' })).toEqual([
      'projects/github.com__acme__app/cp',
      'projects/Acme__App/cp',
    ]);
  });

  it('prefers the registered (alias-expanded) key', () => {
    expect(
      cpCachePrefixes({
        boxId: 'b',
        repoKey: KEY,
        originUrl: 'git@github-work:acme/app.git',
      })[0],
    ).toBe('projects/github.com__acme__app/cp');
  });

  it('falls back to the box scope with no remote', () => {
    expect(cpCachePrefixes({ boxId: 'b' })).toEqual(['boxes/b/cp']);
  });
});
