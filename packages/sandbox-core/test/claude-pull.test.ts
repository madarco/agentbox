import { describe, expect, it } from 'vitest';
import {
  mergeInstalledPlugins,
  mergeKnownMarketplaces,
  pickNewItems,
  referencedPluginVersionKeys,
  SKILL_EXCLUDE_PREFIXES,
} from '../src/sync/claude-pull.js';

describe('pickNewItems', () => {
  it('returns box names absent on host, sorted', () => {
    expect(pickNewItems(['b', 'a', 'c'], ['b'])).toEqual(['a', 'c']);
  });

  it('drops names matching an exclude prefix', () => {
    expect(pickNewItems(['agentbox-setup', 'my-skill'], [], SKILL_EXCLUDE_PREFIXES)).toEqual([
      'my-skill',
    ]);
  });

  it('dedupes and ignores empties', () => {
    expect(pickNewItems(['a', 'a', ''], [])).toEqual(['a']);
  });

  it('is a no-op when everything already exists on host', () => {
    expect(pickNewItems(['a', 'b'], ['a', 'b'])).toEqual([]);
  });
});

describe('mergeKnownMarketplaces', () => {
  const hostHome = '/Users/marco';

  it('adds a box-only marketplace and rewrites installLocation to the host path', () => {
    const host = {
      existing: { source: { source: 'github', repo: 'x/y' }, installLocation: '/Users/marco/.claude/plugins/marketplaces/existing' },
    };
    const box = {
      existing: { source: { source: 'github', repo: 'x/y' }, installLocation: '/home/vscode/.claude/plugins/marketplaces/existing' },
      added: { source: { source: 'github', repo: 'a/b' }, installLocation: '/home/vscode/.claude/plugins/marketplaces/added' },
    };
    const r = mergeKnownMarketplaces(host, box, { hostHome });
    expect(r.changed).toBe(true);
    expect(r.addedKeys).toEqual(['added']);
    const data = r.data as Record<string, { installLocation: string }>;
    // Existing host entry untouched.
    expect(data['existing']!.installLocation).toBe(
      '/Users/marco/.claude/plugins/marketplaces/existing',
    );
    // New entry's container path rewritten back to the host path.
    expect(data['added']!.installLocation).toBe(
      '/Users/marco/.claude/plugins/marketplaces/added',
    );
  });

  it('is unchanged when the box has no new marketplaces', () => {
    const host = { a: { installLocation: '/Users/marco/.claude/plugins/marketplaces/a' } };
    const box = { a: { installLocation: '/home/vscode/.claude/plugins/marketplaces/a' } };
    const r = mergeKnownMarketplaces(host, box, { hostHome });
    expect(r.changed).toBe(false);
    expect(r.data).toBe(host);
  });

  it('tolerates garbage box JSON (no change)', () => {
    const host = { a: {} };
    const r = mergeKnownMarketplaces(host, 'not-an-object', { hostHome });
    expect(r.changed).toBe(false);
    expect(r.data).toBe(host);
  });
});

describe('mergeInstalledPlugins', () => {
  const hostHome = '/Users/marco';

  it('adds a box-only plugin under .plugins, rewrites installPath, preserves version', () => {
    const host = {
      version: 2,
      plugins: {
        'a@mkt': [{ scope: 'user', installPath: '/Users/marco/.claude/plugins/cache/mkt/a/unknown' }],
      },
    };
    const box = {
      version: 2,
      plugins: {
        'a@mkt': [{ scope: 'user', installPath: '/home/vscode/.claude/plugins/cache/mkt/a/unknown' }],
        'b@mkt': [{ scope: 'user', installPath: '/home/vscode/.claude/plugins/cache/mkt/b/unknown' }],
      },
    };
    const r = mergeInstalledPlugins(host, box, { hostHome });
    expect(r.changed).toBe(true);
    expect(r.addedKeys).toEqual(['b@mkt']);
    const data = r.data as { version: number; plugins: Record<string, Array<{ installPath: string }>> };
    expect(data.version).toBe(2);
    expect(data.plugins['a@mkt']![0]!.installPath).toBe(
      '/Users/marco/.claude/plugins/cache/mkt/a/unknown',
    );
    expect(data.plugins['b@mkt']![0]!.installPath).toBe(
      '/Users/marco/.claude/plugins/cache/mkt/b/unknown',
    );
  });

  it('seeds .plugins when the host file is missing/garbage', () => {
    const box = { version: 2, plugins: { 'b@mkt': [{ installPath: '/home/vscode/.claude/plugins/cache/mkt/b/unknown' }] } };
    const r = mergeInstalledPlugins(undefined, box, { hostHome });
    expect(r.changed).toBe(true);
    const data = r.data as { plugins: Record<string, Array<{ installPath: string }>> };
    expect(data.plugins['b@mkt']![0]!.installPath).toBe(
      '/Users/marco/.claude/plugins/cache/mkt/b/unknown',
    );
  });

  it('is unchanged when no new plugins', () => {
    const host = { version: 2, plugins: { 'a@mkt': [{ installPath: '/Users/marco/.claude/plugins/cache/mkt/a/unknown' }] } };
    const box = { version: 2, plugins: { 'a@mkt': [{ installPath: '/home/vscode/.claude/plugins/cache/mkt/a/unknown' }] } };
    const r = mergeInstalledPlugins(host, box, { hostHome });
    expect(r.changed).toBe(false);
  });
});

describe('referencedPluginVersionKeys', () => {
  it('reduces each installPath to its <m>/<p>/<v> key (container paths)', () => {
    const json = {
      version: 2,
      plugins: {
        'vercel@cpo': [
          { scope: 'user', installPath: '/home/vscode/.claude/plugins/cache/cpo/vercel/0.42.1' },
        ],
        'figma@cpo': [
          { scope: 'user', installPath: '/home/vscode/.claude/plugins/cache/cpo/figma/2.2.12' },
        ],
      },
    };
    expect(referencedPluginVersionKeys(json)).toEqual(
      new Set(['cpo/vercel/0.42.1', 'cpo/figma/2.2.12']),
    );
  });

  it('works on host-rooted installPaths and an "unknown" version segment', () => {
    const json = {
      plugins: {
        'a@mkt': [{ installPath: '/Users/marco/.claude/plugins/cache/mkt/a/unknown' }],
      },
    };
    expect(referencedPluginVersionKeys(json)).toEqual(new Set(['mkt/a/unknown']));
  });

  it('keeps every version when one plugin is referenced under two scopes', () => {
    const json = {
      plugins: {
        'a@mkt': [
          { scope: 'user', installPath: '/home/vscode/.claude/plugins/cache/mkt/a/2.0.0' },
          { scope: 'project', installPath: '/home/vscode/.claude/plugins/cache/mkt/a/1.0.0' },
        ],
      },
    };
    expect(referencedPluginVersionKeys(json)).toEqual(
      new Set(['mkt/a/2.0.0', 'mkt/a/1.0.0']),
    );
  });

  it('skips entries with no usable installPath', () => {
    const json = {
      plugins: {
        'a@mkt': [{ scope: 'user' }, { installPath: 42 }, { installPath: 'too/short' }],
        'b@mkt': [{ installPath: '/home/vscode/.claude/plugins/cache/mkt/b/1.0.0' }],
      },
    };
    expect(referencedPluginVersionKeys(json)).toEqual(new Set(['mkt/b/1.0.0']));
  });

  it('returns an empty set for missing / non-object / structureless input', () => {
    expect(referencedPluginVersionKeys(undefined)).toEqual(new Set());
    expect(referencedPluginVersionKeys('garbage')).toEqual(new Set());
    expect(referencedPluginVersionKeys({})).toEqual(new Set());
    expect(referencedPluginVersionKeys({ plugins: [] })).toEqual(new Set());
  });
});
