import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAgentPluginRecord, type AgentPluginRecord } from '../src/plugin-agents.js';
import { exampleSpec } from '../src/specs/example.js';

/**
 * `AGENT_SPECS` merges built-ins with the plugin snapshot at import, so the
 * merge is exercised through a fresh module instance with the registry path
 * pointed at a fixture — never the developer's real `~/.agentbox`.
 */
let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentbox-agents-merge-'));
  file = join(dir, 'agents.json');
  vi.resetModules();
});
afterEach(async () => {
  vi.doUnmock('../src/plugin-agents.js');
  await rm(dir, { recursive: true, force: true });
});

function record(specs: AgentPluginRecord['specs']): AgentPluginRecord {
  return {
    packageName: 'agentbox-agent-demo',
    resolvedEntry: '/pkgs/demo/dist/index.js',
    version: '1.0.0',
    specs,
    apiVersion: 1,
    addedAt: '2026-08-31T00:00:00.000Z',
  };
}

async function loadRegistryWith(specs: AgentPluginRecord['specs']) {
  await addAgentPluginRecord(record(specs), file);
  const real = await import('../src/plugin-agents.js');
  vi.doMock('../src/plugin-agents.js', () => ({
    ...real,
    pluginAgentSpecs: () => real.pluginAgentSpecs(file),
  }));
  return import('../src/index.js');
}

describe('AGENT_SPECS merges plugin agents', () => {
  it('adds an installed agent to the table the whole product reads', async () => {
    const { AGENT_SPECS, findAgentSpec, BUILTIN_AGENT_SPECS } = await loadRegistryWith({
      demo: { ...exampleSpec, id: 'demo', aliases: ['demo-agent'], hidden: false },
    });
    expect(AGENT_SPECS.map((s) => s.id)).toContain('demo');
    expect(AGENT_SPECS.length).toBe(BUILTIN_AGENT_SPECS.length + 1);
    // Resolvable by alias too, or `agentbox demo-agent` would not find it.
    expect(findAgentSpec('demo-agent')?.id).toBe('demo');
  });

  it('lets a built-in win — a plugin cannot shadow a shipped agent', async () => {
    const { AGENT_SPECS, findAgentSpec } = await loadRegistryWith({
      claude: { ...exampleSpec, id: 'claude', aliases: [], binary: 'evil' },
    });
    expect(AGENT_SPECS.filter((s) => s.id === 'claude')).toHaveLength(1);
    expect(findAgentSpec('claude')?.binary).not.toBe('evil');
    // Same trap as the alias case: a duplicate entry would still resolve to the
    // built-in, so the length check above is what actually holds the line.
  });

  it("refuses a plugin that claims a built-in's ALIAS", async () => {
    // `claude-code` resolves to claude. A plugin taking it would silently
    // capture every `agentbox claude-code`.
    const { AGENT_SPECS, findAgentSpec } = await loadRegistryWith({
      impostor: { ...exampleSpec, id: 'impostor', aliases: ['claude-code'] },
    });
    // Asserting on `findAgentSpec` ALONE would pass for the wrong reason —
    // built-ins are scanned first, so claude wins whether or not the impostor
    // was admitted. The real claim is that it never entered the table.
    expect(AGENT_SPECS.map((s) => s.id)).not.toContain('impostor');
    expect(findAgentSpec('claude-code')?.id).toBe('claude');
  });

  it('keeps `builtinAgentIds()` to the built-ins only', async () => {
    const { builtinAgentIds } = await loadRegistryWith({
      demo: { ...exampleSpec, id: 'demo', aliases: [] },
    });
    expect(builtinAgentIds()).not.toContain('demo');
  });
});
