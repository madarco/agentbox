import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pluginAgentSettings } from '../src/agent-plugins.js';

/**
 * An agent installed from an npm package declares settings the same way a
 * built-in does, and they become real `agentbox config set` keys.
 *
 * This is the half of the mechanism that has no compile-time anchor: nothing in
 * this repo knows the agent exists, so if the read degrades silently the setting
 * is simply unaddressable and every test still passes.
 */

function agentsFile(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentbox-agents-'));
  const path = join(dir, 'agents.json');
  writeFileSync(path, JSON.stringify(body));
  return path;
}

// A FICTIONAL agent id, and it has to stay fictional: `installedAgentKeys()`
// deliberately drops any id that is also a built-in, so naming a shipped agent
// here would make this test assert the opposite of what it means.
const PLUGIN_SETTING = {
  key: 'flavour',
  type: 'enum',
  enumValues: ['a', 'b'],
  default: 'a',
  description: 'Which flavour.',
};

describe('pluginAgentSettings', () => {
  it('reads a declared setting out of an installed agent record', () => {
    const path = agentsFile({
      version: 1,
      agents: [{ specs: { sidewinder: { id: 'sidewinder', settings: [PLUGIN_SETTING] } } }],
    });
    expect(pluginAgentSettings(path)).toEqual([{ id: 'sidewinder', settings: [PLUGIN_SETTING] }]);
  });

  it('degrades to nothing rather than throwing', () => {
    // A config layer that throws on load bricks every command, so every failure
    // mode here has to be silent: no file, unparseable JSON, wrong shape.
    expect(pluginAgentSettings(join(tmpdir(), 'agentbox-nope', 'agents.json'))).toEqual([]);
    const bad = agentsFile('not an object');
    writeFileSync(bad, '{ not json');
    expect(pluginAgentSettings(bad)).toEqual([]);
    expect(pluginAgentSettings(agentsFile({ version: 1 }))).toEqual([]);
  });

  it('drops a setting a hand edit made unusable', () => {
    // The file is user-writable and the validator at `agent add` time only saw
    // the version that was added. A malformed row must not become a key whose
    // coercion then throws on every config read.
    const path = agentsFile({
      version: 1,
      agents: [
        {
          specs: {
            sidewinder: {
              id: 'sidewinder',
              settings: [
                PLUGIN_SETTING,
                { key: 'no-type', default: 'x', description: 'd' },
                { key: 'enum-without-values', type: 'enum', default: 'x', description: 'd' },
                {
                  key: 'default-outside-enum',
                  type: 'enum',
                  enumValues: ['a'],
                  default: 'z',
                  description: 'd',
                },
                { key: 'wrong-default-type', type: 'bool', default: 'yes', description: 'd' },
                // A dotted leaf would generate `sidewinder.a.b`, which the parser
                // reads as a nested branch nothing materialises.
                { key: 'a.b', type: 'string', default: '', description: 'd' },
              ],
            },
          },
        },
      ],
    });
    expect(pluginAgentSettings(path)).toEqual([{ id: 'sidewinder', settings: [PLUGIN_SETTING] }]);
  });
});

describe('the key registry folds them in', () => {
  it('makes `<agent>.<setting>` addressable, and defaults it', async () => {
    // The registry is resolved at module load, so the file has to exist before
    // the import — the same "next command sees it" contract AGENT_SPECS has.
    const path = agentsFile({
      version: 1,
      agents: [{ specs: { sidewinder: { id: 'sidewinder', settings: [PLUGIN_SETTING] } } }],
    });
    vi.resetModules();
    vi.doMock('../src/paths.js', async () => ({
      ...(await vi.importActual<typeof import('../src/paths.js')>('../src/paths.js')),
      AGENTS_FILE: path,
    }));
    const { KEY_REGISTRY, BUILTIN_KEY_REGISTRY, BUILT_IN_DEFAULTS } =
      await import('../src/types.js');
    const keys = KEY_REGISTRY.map((d) => d.key);
    expect(keys).toContain('sidewinder.flavour');
    expect(BUILTIN_KEY_REGISTRY.map((d) => d.key)).not.toContain('sidewinder.flavour');
    expect((BUILT_IN_DEFAULTS as unknown as Record<string, unknown>)['sidewinder']).toMatchObject({
      flavour: 'a',
    });
    vi.doUnmock('../src/paths.js');
    vi.resetModules();
  });
});
