import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeRecordingTransport,
  planPropagateTargets,
  propagateStagedSettings,
  transportSettingsTarget,
  type SettingsTarget,
} from '../src/index.js';

// The three `<agent>StagedItems` mappers moved to their agent packages; their
// tests went with them (`packages/agent-<id>/test/staged-items.test.ts`).

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

  /**
   * The bug this pins: the volume lookup was a `switch` whose `default:` arm
   * returned `box.opencodeConfigVolume`, so an agent outside the named two had
   * its credentials fanned into OPENCODE's store. Nothing failed — the two
   * tests above pass either way, because they only ever ask about claude and
   * codex, which the switch named.
   */
  it("never answers another agent's volume for an agent it does not name", () => {
    const isolated = [
      {
        id: 'x',
        name: 'docker-x',
        provider: 'docker',
        projectRoot: '/p1',
        agentConfigVolumes: {
          example: 'agentbox-example-config-x',
          opencode: 'agentbox-opencode-config-x',
        },
      },
    ];
    const plan = planPropagateTargets(isolated, {
      agent: 'example',
      sourceBoxId: 's',
      scope: 'all',
    });
    expect(plan.dockerVolumes.map((v) => v.volume)).toEqual(['agentbox-example-config-x']);
  });

  it('falls back to the legacy named fields for a box recorded before the map', () => {
    // `agentConfigVolumes` is additive: a box created by an older CLI carries
    // only the three flat fields, and must keep resolving.
    const legacy = [
      {
        id: 'y',
        name: 'docker-y',
        provider: 'docker',
        projectRoot: '/p1',
        opencodeConfigVolume: 'agentbox-opencode-config-y',
      },
    ];
    const plan = planPropagateTargets(legacy, {
      agent: 'opencode',
      sourceBoxId: 's',
      scope: 'all',
    });
    expect(plan.dockerVolumes.map((v) => v.volume)).toEqual(['agentbox-opencode-config-y']);
  });
});

describe('agentBoxConfigDir', () => {
  /**
   * Same `default:` bug, other half: this returned OPENCODE's box dir for any
   * agent it did not name, so a fourth agent's staged config was written under
   * `~/.local/share/opencode` inside the box.
   */
  it('derives every agent`s box dir from the registry', async () => {
    const { agentBoxConfigDir } = await import('../src/index.js');
    const { AGENT_SYNC_SPECS } = await import('../src/index.js');
    for (const spec of AGENT_SYNC_SPECS) {
      expect(agentBoxConfigDir(spec.id)).toBe(spec.staticPaths[0]?.boxDir);
    }
    // Explicit: the demo agent is neither claude nor codex, and must not be
    // told its config lives in opencode's directory.
    expect(agentBoxConfigDir('example')).toBe('/home/vscode/.agentbox-example');
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

describe('planPropagateTargets — per-agent box selection', () => {
  it('skips a cloud box that was not created for this agent', () => {
    // The fan-out pushes STRAIGHT INTO a cloud box, so without this gate a
    // resume re-seeds every agent's token and undoes the create-time isolation.
    // Found by a live daytona box: codex/opencode auth.json reappeared on
    // resume even though the box was created with agents:['claude'].
    const boxes = [
      { id: 'a', name: 'claudebox', provider: 'daytona', agents: ['claude'] },
      { id: 'b', name: 'codexbox', provider: 'daytona', agents: ['codex'] },
      { id: 'c', name: 'legacy', provider: 'daytona' },
    ];
    const plan = planPropagateTargets(boxes, {
      agent: 'codex',
      sourceBoxId: 'zzz',
      scope: 'all',
    });
    const names = plan.cloudBoxes.map((b) => b.name).sort();
    // the codex box, plus the pre-selection box (absent = all, historical)
    expect(names).toEqual(['codexbox', 'legacy']);
  });

  it('still reaches every cloud box when none declare a selection', () => {
    const boxes = [
      { id: 'a', name: 'one', provider: 'daytona' },
      { id: 'b', name: 'two', provider: 'hetzner' },
    ];
    const plan = planPropagateTargets(boxes, {
      agent: 'claude',
      sourceBoxId: 'zzz',
      scope: 'all',
    });
    expect(plan.cloudBoxes.map((b) => b.name).sort()).toEqual(['one', 'two']);
  });
});
