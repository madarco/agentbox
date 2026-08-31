import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addAgentPluginRecord,
  agentSpecProblem,
  pluginAgentSpecs,
  pluginForAgent,
  readAgentRegistrySync,
  removeAgentPluginRecord,
  type AgentPluginRecord,
} from '../src/plugin-agents.js';
import { exampleSpec } from '../src/specs/example.js';

// Every call takes an explicit path. Nothing here may touch the developer's
// real ~/.agentbox/agents.json.
let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentbox-agents-registry-'));
  file = join(dir, 'agents.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function record(over: Partial<AgentPluginRecord> = {}): AgentPluginRecord {
  return {
    packageName: 'agentbox-agent-demo',
    resolvedEntry: '/pkgs/agentbox-agent-demo/dist/index.js',
    version: '1.0.0',
    specs: { demo: { ...exampleSpec, id: 'demo', aliases: [] } },
    apiVersion: 1,
    addedAt: '2026-08-31T00:00:00.000Z',
    ...over,
  };
}

describe('the agent plugin registry file', () => {
  it('round-trips a registration', async () => {
    await addAgentPluginRecord(record(), file);
    expect(pluginAgentSpecs(file).map((s) => s.id)).toEqual(['demo']);
    expect(pluginForAgent('demo', file)?.packageName).toBe('agentbox-agent-demo');
    expect(pluginForAgent('claude', file)).toBeUndefined();
  });

  it('re-registering a package replaces it rather than duplicating it', async () => {
    await addAgentPluginRecord(record(), file);
    await addAgentPluginRecord(record({ version: '2.0.0' }), file);
    const f = readAgentRegistrySync(file);
    expect(f.agents).toHaveLength(1);
    expect(f.agents[0]?.version).toBe('2.0.0');
  });

  it('removes a registration, and reports when there was none', async () => {
    await addAgentPluginRecord(record(), file);
    expect(await removeAgentPluginRecord('agentbox-agent-demo', file)).toBe(true);
    expect(pluginAgentSpecs(file)).toEqual([]);
    expect(await removeAgentPluginRecord('agentbox-agent-demo', file)).toBe(false);
  });

  it('reads a missing file as empty rather than throwing', () => {
    expect(readAgentRegistrySync(join(dir, 'nope.json')).agents).toEqual([]);
    expect(pluginAgentSpecs(join(dir, 'nope.json'))).toEqual([]);
  });

  it('degrades a corrupt file to empty — it must not brick every box command', async () => {
    await writeFile(file, '{ not json');
    expect(pluginAgentSpecs(file)).toEqual([]);
  });

  it('REFUSES to write over a corrupt file, rather than dropping other agents', async () => {
    // The read path is lenient so nothing bricks; the write path must not be,
    // or `agent add` would silently discard a recoverable registry.
    await writeFile(file, '{ not json');
    await expect(addAgentPluginRecord(record(), file)).rejects.toThrow(/not valid JSON/);
  });

  it('skips a record whose API version this build does not support', async () => {
    await addAgentPluginRecord(record({ apiVersion: 99 }), file);
    // Skipped, not fatal: an agent added by a newer AgentBox must not break an
    // older one — it is simply unavailable.
    expect(pluginAgentSpecs(file)).toEqual([]);
  });

  it('skips a spec that fails validation, in case the file was hand-edited', async () => {
    await addAgentPluginRecord(record({ specs: { broken: { id: 'broken' } as never } }), file);
    expect(pluginAgentSpecs(file)).toEqual([]);
  });
});

describe('agentSpecProblem', () => {
  it('accepts a real spec', () => {
    expect(agentSpecProblem(exampleSpec)).toBeNull();
  });

  it('names every missing required field at once', () => {
    const problem = agentSpecProblem({ id: 'x', aliases: [] });
    expect(problem).toMatch(/missing required field/);
    expect(problem).toContain('sessionName');
    expect(problem).toContain('credential');
  });

  it('rejects a structurally wrong `install`, not merely a missing one', () => {
    // The exact shape that slipped through a presence-only check and then threw
    // at bake time, where the author is long gone.
    expect(agentSpecProblem({ ...exampleSpec, install: { kind: 'none' } })).toMatch(
      /install\.recipe/,
    );
    expect(
      agentSpecProblem({ ...exampleSpec, install: { recipe: { kind: 'nope' }, runAs: 'root' } }),
    ).toMatch(/recipe\.kind/);
    expect(
      agentSpecProblem({ ...exampleSpec, install: { recipe: { kind: 'npm' }, runAs: 'root' } }),
    ).toMatch(/recipe\.package/);
    // `runAs` decides whether the binary lands where the box user can see it.
    expect(
      agentSpecProblem({
        ...exampleSpec,
        install: { recipe: { kind: 'exec', script: 'true' } },
      }),
    ).toMatch(/runAs/);
  });

  it('rejects a credential backup path the fan-out cannot write to', () => {
    // An empty or relative path drops a temp file in the process cwd and loses
    // the login, silently.
    for (const hostBackup of ['', 'relative/path.json']) {
      expect(
        agentSpecProblem({
          ...exampleSpec,
          credential: { ...exampleSpec.credential, hostBackup },
        }),
        hostBackup || '(empty)',
      ).toMatch(/hostBackup/);
    }
  });

  it('rejects a staticPaths entry that cannot be staged', () => {
    expect(
      agentSpecProblem({ ...exampleSpec, staticPaths: [{ hostHomeRel: '.x', boxDir: '/b' }] }),
    ).toMatch(/hostHomeRel/);
    expect(
      agentSpecProblem({ ...exampleSpec, staticPaths: [{ hostHomeRel: ['.x'], boxDir: 'rel' }] }),
    ).toMatch(/boxDir/);
  });

  it('refuses a staticPath that would stage the whole home directory', () => {
    // `join(homedir(), ...[])` IS homedir(). A spec with an empty
    // `hostHomeRel` — or an empty segment — would make cloud staging rsync the
    // user's entire home into a snapshot every box then shares.
    for (const hostHomeRel of [[], [''], ['.ok', '']]) {
      expect(
        agentSpecProblem({
          ...exampleSpec,
          staticPaths: [{ hostHomeRel, boxDir: '/home/vscode/.x' }],
        }),
        JSON.stringify(hostHomeRel),
      ).toMatch(/hostHomeRel/);
    }
  });

  it('refuses a relative credential path the push would truncate', () => {
    // The push derives the dir with `slice(0, lastIndexOf('/'))`, so
    // `auth.json` gives an empty dir and the copy silently never lands.
    expect(
      agentSpecProblem({
        ...exampleSpec,
        credential: { ...exampleSpec.credential, boxAbsPath: 'auth.json' },
      }),
    ).toMatch(/boxAbsPath/);
  });

  it('rejects a non-object and an empty id', () => {
    expect(agentSpecProblem('claude')).toBe('not an object');
    expect(agentSpecProblem({ ...exampleSpec, id: '' })).toMatch(/non-empty string/);
  });
});
