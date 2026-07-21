import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeStagedItems,
  codexStagedItems,
  makeRecordingTransport,
  opencodeStagedItems,
  planPropagateTargets,
  propagateStagedSettings,
  transportSettingsTarget,
  type SettingsTarget,
} from '../src/index.js';

describe('staged item mappers', () => {
  it('claude: category rels, plugins under plugins/cache', () => {
    expect(
      claudeStagedItems({
        newItems: [
          { category: 'skills', name: 'foo' },
          { category: 'plugins', name: 'mkt/plug' },
        ],
        mergedRegistries: [],
      }),
    ).toEqual([
      { rel: 'skills/foo', label: 'skills/foo', kind: 'dir' },
      { rel: 'plugins/cache/mkt/plug', label: 'plugins/mkt/plug', kind: 'dir' },
    ]);
  });

  it('codex: prompts is a dir, the rest are files', () => {
    expect(codexStagedItems(['config.toml', 'prompts']).map((i) => i.kind)).toEqual([
      'file',
      'dir',
    ]);
  });

  it('opencode: auth/global config are files, extension dirs are dirs', () => {
    expect(
      opencodeStagedItems(['auth.json', 'config/opencode.json', 'config/skills']).map(
        (i) => [i.rel, i.kind],
      ),
    ).toEqual([
      ['auth.json', 'file'],
      ['config/opencode.json', 'file'],
      ['config/skills', 'dir'],
    ]);
  });
});

describe('planPropagateTargets', () => {
  const boxes = [
    { id: 's', name: 'source', provider: 'docker', projectRoot: '/p1' },
    { id: 'a', name: 'docker-a', provider: 'docker', projectRoot: '/p1' },
    { id: 'b', name: 'docker-b', provider: 'docker', projectRoot: '/p2' },
    {
      id: 'c',
      name: 'docker-iso',
      provider: 'docker',
      projectRoot: '/p1',
      claudeConfigVolume: 'agentbox-claude-config-c',
    },
    { id: 'd', name: 'cloud-d', provider: 'vercel', projectRoot: '/p1' },
    { id: 'e', name: 'cloud-e', provider: 'hetzner', projectRoot: '/p2' },
  ];

  it('scope=all: dedups shared volume, lists isolated + cloud', () => {
    const plan = planPropagateTargets(boxes, {
      agent: 'claude',
      sourceBoxId: 's',
      scope: 'all',
    });
    expect(plan.dockerVolumes).toEqual([
      { volume: 'agentbox-claude-config', boxNames: ['docker-a', 'docker-b'], shared: true },
      { volume: 'agentbox-claude-config-c', boxNames: ['docker-iso'], shared: false },
    ]);
    expect(plan.cloudBoxes.map((b) => b.name)).toEqual(['cloud-d', 'cloud-e']);
  });

  it('scope=project filters by the source projectRoot', () => {
    const plan = planPropagateTargets(boxes, {
      agent: 'claude',
      sourceBoxId: 's',
      scope: 'project',
      projectRoot: '/p1',
    });
    expect(plan.dockerVolumes.map((v) => v.boxNames)).toEqual([['docker-a'], ['docker-iso']]);
    expect(plan.cloudBoxes.map((b) => b.name)).toEqual(['cloud-d']);
  });

  it('excludeVolume drops the source volume (shared-volume no-op guard)', () => {
    const plan = planPropagateTargets(boxes, {
      agent: 'claude',
      sourceBoxId: 's',
      scope: 'all',
      excludeVolume: 'agentbox-claude-config',
    });
    expect(plan.dockerVolumes.map((v) => v.volume)).toEqual(['agentbox-claude-config-c']);
  });

  it('uses the per-agent volume field (codex ignores claude isolation)', () => {
    const plan = planPropagateTargets(boxes, {
      agent: 'codex',
      sourceBoxId: 's',
      scope: 'all',
    });
    expect(plan.dockerVolumes).toEqual([
      {
        volume: 'agentbox-codex-config',
        boxNames: ['docker-a', 'docker-b', 'docker-iso'],
        shared: true,
      },
    ]);
  });
});

/** In-memory SettingsTarget: `files` maps rel → text (dirs tracked as rels). */
function memoryTarget(initial: Record<string, string> = {}): SettingsTarget & {
  files: Map<string, string>;
  copies: Array<{ rel: string; kind: string }>;
} {
  const files = new Map(Object.entries(initial));
  const copies: Array<{ rel: string; kind: string }> = [];
  return {
    label: 'memory',
    files,
    copies,
    async exists(rel) {
      return files.has(rel);
    },
    async readText(rel) {
      return files.get(rel) ?? null;
    },
    async writeText(rel, content) {
      files.set(rel, content);
    },
    async copyIn(_stagingAbs, rel, kind) {
      files.set(rel, `<${kind}>`);
      copies.push({ rel, kind });
    },
  };
}

describe('propagateStagedSettings', () => {
  let staging: string;

  beforeEach(async () => {
    staging = await mkdtemp(join(tmpdir(), 'propagate-staging-'));
  });
  afterEach(async () => {
    await rm(staging, { recursive: true, force: true });
  });

  it('copies missing items, skips existing ones (additive)', async () => {
    const target = memoryTarget({ 'skills/have': '<dir>' });
    const result = await propagateStagedSettings(target, {
      agent: 'claude',
      stagingDir: staging,
      items: [
        { rel: 'skills/have', label: 'skills/have', kind: 'dir' },
        { rel: 'skills/fresh', label: 'skills/fresh', kind: 'dir' },
      ],
    });
    expect(result.copied).toEqual(['skills/fresh']);
    expect(result.skipped).toEqual(['skills/have']);
    expect(target.copies).toEqual([{ rel: 'skills/fresh', kind: 'dir' }]);
  });

  it('merges claude registries target-wins, writing only on change', async () => {
    const target = memoryTarget({
      'plugins/known_marketplaces.json': JSON.stringify({ mkt: { source: 'target' } }),
    });
    const result = await propagateStagedSettings(target, {
      agent: 'claude',
      stagingDir: staging,
      items: [],
      sourceRegistries: {
        known_marketplaces: { mkt: { source: 'source' }, extra: { source: 'source' } },
        installed_plugins: {},
      },
    });
    expect(result.mergedRegistries).toEqual(['plugins/known_marketplaces.json']);
    const merged = JSON.parse(target.files.get('plugins/known_marketplaces.json')!) as Record<
      string,
      { source: string }
    >;
    expect(merged['mkt']!.source).toBe('target'); // target wins
    expect(merged['extra']!.source).toBe('source');
  });

  it('does not merge registries for non-claude agents', async () => {
    const target = memoryTarget();
    const result = await propagateStagedSettings(target, {
      agent: 'codex',
      stagingDir: staging,
      items: [{ rel: 'prompts', label: 'prompts', kind: 'dir' }],
      sourceRegistries: { known_marketplaces: { x: {} } },
    });
    expect(result.mergedRegistries).toEqual([]);
    expect(result.copied).toEqual(['prompts']);
  });
});

describe('transportSettingsTarget', () => {
  it('roots rels at the box config dir and probes existence via exec', async () => {
    const existing = new Set(['/home/vscode/.claude/skills/have']);
    const t = makeRecordingTransport({
      execResult: (cmd) => {
        const probe = /test -e '([^']+)'/.exec(cmd.join(' '));
        if (probe) return { exitCode: existing.has(probe[1]!) ? 0 : 1, stdout: '', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const target = transportSettingsTarget(t, '/home/vscode/.claude', 'box-a');
    expect(await target.exists('skills/have')).toBe(true);
    expect(await target.exists('skills/fresh')).toBe(false);

    const staging = await mkdtemp(join(tmpdir(), 'propagate-staging-'));
    try {
      await mkdir(join(staging, 'skills', 'fresh'), { recursive: true });
      await writeFile(join(staging, 'skills', 'fresh', 'SKILL.md'), 'x');
      await target.copyIn(join(staging, 'skills/fresh'), 'skills/fresh', 'dir');
      const push = t.ops.find((o) => o.op === 'pushTree');
      expect(push!.args['boxDestDir']).toBe('/home/vscode/.claude/skills/fresh');
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
});
