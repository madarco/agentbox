import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildClaudeMounts,
  resolveClaudeVolume,
  scanPluginCacheForRebuild,
  SHARED_CLAUDE_VOLUME,
} from '../src/claude.js';

describe('resolveClaudeVolume', () => {
  it('returns the shared volume name when isolate is false', () => {
    expect(resolveClaudeVolume({ isolate: false, boxId: 'aabbccdd' })).toEqual({
      volume: SHARED_CLAUDE_VOLUME,
    });
  });

  it('returns a per-box volume name when isolate is true', () => {
    expect(resolveClaudeVolume({ isolate: true, boxId: 'aabbccdd' })).toEqual({
      volume: `${SHARED_CLAUDE_VOLUME}-aabbccdd`,
    });
  });
});

describe('buildClaudeMounts', () => {
  it('mounts the resolved volume at /home/vscode/.claude', () => {
    const result = buildClaudeMounts({ volume: 'my-vol' }, {});
    expect(result.extraVolumes).toEqual(['my-vol:/home/vscode/.claude']);
    expect(result.volumeName).toBe('my-vol');
  });

  it('forwards ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN when set', () => {
    const result = buildClaudeMounts(
      { volume: 'v' },
      { ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CODE_OAUTH_TOKEN: 'oat-1' },
    );
    expect(result.env).toEqual({
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CODE_OAUTH_TOKEN: 'oat-1',
    });
  });

  it('forwards CLAUDE_EFFORT and ANTHROPIC_MODEL when set', () => {
    const result = buildClaudeMounts(
      { volume: 'v' },
      { CLAUDE_EFFORT: 'xhigh', ANTHROPIC_MODEL: 'claude-opus-4-7' },
    );
    expect(result.env).toEqual({
      CLAUDE_EFFORT: 'xhigh',
      ANTHROPIC_MODEL: 'claude-opus-4-7',
    });
  });

  it('skips empty/missing env values rather than injecting blanks', () => {
    const result = buildClaudeMounts(
      { volume: 'v' },
      {
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CLAUDE_EFFORT: '',
        ANTHROPIC_MODEL: undefined,
        OTHER_KEY: 'x',
      },
    );
    expect(result.env).toEqual({});
  });
});

describe('scanPluginCacheForRebuild', () => {
  let root: string;
  const versionDir = (m: string, p: string, v: string) =>
    join(root, m, p, v);
  const seed = async (m: string, p: string, v: string, files: string[]) => {
    const d = versionDir(m, p, v);
    await mkdir(d, { recursive: true });
    for (const f of files) await writeFile(join(d, f), '{}');
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentbox-cache-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns false when the cache root does not exist', async () => {
    expect(await scanPluginCacheForRebuild(join(root, 'nope'))).toBe(false);
  });

  it('returns false when every package.json plugin has the install marker', async () => {
    await seed('mkt', 'plug', '1.0.0', ['package.json', '.agentbox-installed']);
    expect(await scanPluginCacheForRebuild(root)).toBe(false);
  });

  it('returns true when a package.json plugin is missing the marker', async () => {
    await seed('mkt', 'a', '1.0.0', ['package.json', '.agentbox-installed']);
    await seed('mkt', 'b', '2.1.0', ['package.json']);
    expect(await scanPluginCacheForRebuild(root)).toBe(true);
  });

  it('ignores skill-only plugins that ship no package.json', async () => {
    await seed('mkt', 'skill-only', 'unknown', ['SKILL.md']);
    expect(await scanPluginCacheForRebuild(root)).toBe(false);
  });
});
