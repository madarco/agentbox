import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProjectSeedForRepo } from '../src/custody-seed.js';

function store(entries: Record<string, { originUrl?: string; createdAt: string }>) {
  const asked: string[] = [];
  return {
    asked,
    get: (slug: string, rel: string): Promise<Buffer | null> => {
      asked.push(`${slug}/${rel}`);
      const m = entries[slug];
      return Promise.resolve(rel === 'manifest.json' && m ? Buffer.from(JSON.stringify(m)) : null);
    },
  };
}

describe('applyProjectSeedForRepo', () => {
  let dest: string;
  beforeEach(async () => {
    dest = await mkdtemp(join(tmpdir(), 'seed-for-repo-'));
  });
  afterEach(async () => {
    await rm(dest, { recursive: true, force: true });
  });

  it('finds a seed the PC filed under its alias-expanded key', async () => {
    // Origin spelled with an ssh alias the hub cannot expand; the PC sent its key.
    const s = store({ 'github.com__acme__web': { createdAt: 'pc' } });
    const r = await applyProjectSeedForRepo({
      repoUrl: 'git@github-work:acme/web.git',
      repoKeys: ['github.com/acme/web'],
      get: s.get,
      dest,
    });
    expect(r?.capturedAt).toBe('pc');
  });

  it('reads a legacy owner__repo seed when its manifest names the same repo', async () => {
    const s = store({
      acme__web: { originUrl: 'git@gh-old-alias:acme/web.git', createdAt: 'legacy' },
    });
    const r = await applyProjectSeedForRepo({
      repoUrl: 'https://github.com/acme/web.git',
      get: s.get,
      dest,
    });
    expect(r?.capturedAt).toBe('legacy');
  });

  it('refuses a legacy seed that belongs to another repo sharing the slug', async () => {
    // owner__repo dropped the host and subgroups: gitlab x/acme/web shared it.
    const s = store({
      acme__web: { originUrl: 'https://gitlab.com/x/acme/web.git', createdAt: 'other' },
    });
    const logs: string[] = [];
    const r = await applyProjectSeedForRepo({
      repoUrl: 'https://github.com/acme/web.git',
      get: s.get,
      dest,
      log: (l) => logs.push(l),
    });
    expect(r).toBeNull();
    expect(logs.join('\n')).toMatch(/skipping the legacy acme__web seed/);
  });

  it('tries the new slug before the legacy one', async () => {
    const s = store({
      'github.com__acme__web': { createdAt: 'new' },
      acme__web: { originUrl: 'https://github.com/acme/web', createdAt: 'legacy' },
    });
    const r = await applyProjectSeedForRepo({
      repoUrl: 'https://github.com/acme/web.git',
      get: s.get,
      dest,
    });
    expect(r?.capturedAt).toBe('new');
  });
});
