import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeInventoryScript,
  computeClaudePullPlan,
  flatInventoryScript,
  makeRecordingTransport,
  parseClaudeInventory,
  parseFlatInventory,
  pullClaudeExtrasViaTransport,
  pullCodexConfigViaTransport,
  pullOpencodeConfigViaTransport,
  type RecordingSyncTransport,
} from '../src/index.js';

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');

/**
 * The recording transport only records; the pull code chmods auth files after
 * `pullFile`, so materialize an empty host file like a real transport would.
 */
function materializePullFile(t: RecordingSyncTransport): void {
  const orig = t.pullFile.bind(t);
  t.pullFile = async (boxSrcPath: string, hostDestPath: string) => {
    await orig(boxSrcPath, hostDestPath);
    await writeFile(hostDestPath, '');
  };
}

describe('parseClaudeInventory', () => {
  it('parses DIR/PLUGIN/JSON lines and tolerates junk', () => {
    const stdout = [
      'DIR skills my-skill',
      'DIR agents reviewer',
      'DIR commands deploy now', // name with a space
      'PLUGIN mkt/plug',
      `JSON known_marketplaces ${b64({ mkt: { source: 's' } })}`,
      'JSON broken not-base64!!!',
      'garbage line',
      '',
    ].join('\n');
    const inv = parseClaudeInventory(stdout);
    expect(inv.dirs['skills']).toEqual(['my-skill']);
    expect(inv.dirs['agents']).toEqual(['reviewer']);
    expect(inv.dirs['commands']).toEqual(['deploy now']);
    expect(inv.plugins).toEqual(['mkt/plug']);
    expect(inv.registries['known_marketplaces']).toEqual({ mkt: { source: 's' } });
    expect(inv.registries['broken']).toBeUndefined();
  });
});

describe('claudeInventoryScript', () => {
  it('roots every probe at the given src dir', () => {
    const script = claudeInventoryScript('/home/vscode/.claude');
    expect(script).toContain('"/home/vscode/.claude/$cat"');
    expect(script).toContain('/home/vscode/.claude/plugins/cache');
    expect(script).not.toContain('"/src');
  });
});

describe('computeClaudePullPlan', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agent-pull-home-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('is additive: host items are never new, agentbox- skills excluded', async () => {
    await mkdir(join(home, '.claude', 'skills', 'existing'), { recursive: true });
    const plan = await computeClaudePullPlan(
      {
        dirs: { skills: ['existing', 'fresh', 'agentbox-setup'], agents: [], commands: [] },
        plugins: [],
        registries: {},
      },
      { hostHome: home },
    );
    expect(plan.newItems).toEqual([{ category: 'skills', name: 'fresh' }]);
    expect(plan.copyRels).toEqual(['skills/fresh']);
    expect(plan.mergedRegistries).toEqual([]);
  });

  it('computes plugin cache deltas and registry merges', async () => {
    await mkdir(join(home, '.claude', 'plugins', 'cache', 'mkt', 'have'), { recursive: true });
    await writeFile(
      join(home, '.claude', 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ mkt: { source: 'host' } }),
    );
    const plan = await computeClaudePullPlan(
      {
        dirs: { skills: [], agents: [], commands: [] },
        plugins: ['mkt/have', 'mkt/new'],
        registries: {
          known_marketplaces: {
            mkt: { source: 'box-should-not-win' },
            other: { source: 'box' },
          },
        },
      },
      { hostHome: home },
    );
    expect(plan.newItems).toEqual([{ category: 'plugins', name: 'mkt/new' }]);
    expect(plan.copyRels).toEqual(['plugins/cache/mkt/new']);
    expect(plan.mergedRegistries).toEqual(['known_marketplaces.json']);
    const merged = plan.mergedMarkets.data as Record<string, { source: string }>;
    expect(merged['mkt']!.source).toBe('host'); // host wins
    expect(merged['other']!.source).toBe('box');
  });
});

describe('pullClaudeExtrasViaTransport', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agent-pull-home-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('pulls only new items and writes merged registries', async () => {
    const stdout = [
      'DIR skills fresh',
      `JSON known_marketplaces ${b64({ mkt: { source: 'box' } })}`,
    ].join('\n');
    const t = makeRecordingTransport({ execResult: () => ({ exitCode: 0, stdout, stderr: '' }) });
    const result = await pullClaudeExtrasViaTransport(t, { hostHome: home });
    expect(result.newItems).toEqual([{ category: 'skills', name: 'fresh' }]);
    expect(result.mergedRegistries).toEqual(['known_marketplaces.json']);
    const pulls = t.ops.filter((o) => o.op === 'pullTree');
    expect(pulls).toHaveLength(1);
    expect(pulls[0]!.args['boxSrcDir']).toBe('/home/vscode/.claude/skills/fresh');
    expect(pulls[0]!.args['hostDestDir']).toBe(join(home, '.claude', 'skills', 'fresh'));
    const registry = JSON.parse(
      await readFile(join(home, '.claude', 'plugins', 'known_marketplaces.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(registry['mkt']).toEqual({ source: 'box' });
  });

  it('dry-run computes the delta without any pull or write', async () => {
    const t = makeRecordingTransport({
      execResult: () => ({ exitCode: 0, stdout: 'DIR skills fresh', stderr: '' }),
    });
    const result = await pullClaudeExtrasViaTransport(t, { hostHome: home, dryRun: true });
    expect(result.newItems).toHaveLength(1);
    expect(t.ops.filter((o) => o.op !== 'exec')).toHaveLength(0);
  });

  it('throws on a failed inventory exec', async () => {
    const t = makeRecordingTransport({
      execResult: () => ({ exitCode: 1, stdout: '', stderr: 'boom' }),
    });
    await expect(pullClaudeExtrasViaTransport(t, { hostHome: home })).rejects.toThrow('boom');
  });
});

describe('flat inventory (codex/opencode)', () => {
  it('script probes each group dir and tags FILE vs DIR', () => {
    const script = flatInventoryScript({
      data: { dir: '/d', items: ['auth.json'] },
      config: { dir: '/d/config', items: ['skills'] },
    });
    expect(script).toContain('"/d/$f"');
    expect(script).toContain('"/d/config/$f"');
    expect(script).toContain('data DIR');
    expect(script).toContain('config FILE');
  });

  it('parse keeps only well-formed lines', () => {
    expect(
      parseFlatInventory('codex FILE auth.json\ncodex DIR prompts\nnoise\nx y z w\n'),
    ).toEqual([
      { group: 'codex', kind: 'file', name: 'auth.json' },
      { group: 'codex', kind: 'dir', name: 'prompts' },
    ]);
  });
});

describe('pullCodexConfigViaTransport', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agent-pull-home-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('skips items already on the host (additive)', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(join(home, '.codex', 'config.toml'), 'host');
    const stdout = 'codex FILE config.toml\ncodex FILE auth.json\ncodex DIR prompts';
    const t = makeRecordingTransport({ execResult: () => ({ exitCode: 0, stdout, stderr: '' }) });
    materializePullFile(t);
    const result = await pullCodexConfigViaTransport(t, { hostHome: home });
    expect(result.newItems).toEqual(['auth.json', 'prompts']);
    expect(t.ops.filter((o) => o.op === 'pullFile')).toHaveLength(1);
    expect(t.ops.filter((o) => o.op === 'pullTree')).toHaveLength(1);
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toBe('host');
  });
});

describe('pullOpencodeConfigViaTransport', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agent-pull-home-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('routes data vs config groups to their host dirs', async () => {
    const stdout = 'data FILE auth.json\nconfig DIR skills';
    const t = makeRecordingTransport({ execResult: () => ({ exitCode: 0, stdout, stderr: '' }) });
    materializePullFile(t);
    const result = await pullOpencodeConfigViaTransport(t, { hostHome: home });
    expect(result.newItems).toEqual(['auth.json', 'config/skills']);
    const file = t.ops.find((o) => o.op === 'pullFile');
    expect(file!.args['boxSrcPath']).toBe('/home/vscode/.local/share/opencode/auth.json');
    expect(file!.args['hostDestPath']).toBe(join(home, '.local', 'share', 'opencode', 'auth.json'));
    const tree = t.ops.find((o) => o.op === 'pullTree');
    expect(tree!.args['boxSrcDir']).toBe('/home/vscode/.local/share/opencode/config/skills');
    expect(tree!.args['hostDestDir']).toBe(join(home, '.config', 'opencode', 'skills'));
  });
});
