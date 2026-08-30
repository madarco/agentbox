import { describe, expect, it } from 'vitest';
import { AGENT_SYNC_SPECS, resolveAgentSpec } from '../src/sync/registry.js';
import {
  CLAUDE_BOX_CONFIG_DIR,
  CODEX_BOX_CONFIG_DIR,
  OPENCODE_BOX_DATA_DIR,
  CLAUDE_PULL_DIR_CATEGORIES,
  CODEX_PULL_ITEMS,
  OPENCODE_PULL_CONFIG_ITEMS,
  OPENCODE_PULL_DATA_ITEMS,
  agentBoxDir,
} from '../src/sync/agent-pull.js';

/**
 * The box->host (`download`) direction used to restate what the host->box push
 * already knew: three box-dir literals here and three more in the registry,
 * with nothing to catch a divergence. `packages/ctl`'s WATCHED_CREDENTIALS drift
 * test is the precedent this copies.
 *
 * These now derive from the registry, so most of this is a guard against
 * someone reintroducing a literal.
 */
describe('agent-pull derives from the registry', () => {
  it('box dirs match staticPaths[0].boxDir for every agent', () => {
    for (const spec of AGENT_SYNC_SPECS) {
      expect(agentBoxDir(spec.id), spec.id).toBe(spec.staticPaths[0]?.boxDir);
    }
  });

  it('the exported constants are the derived values', () => {
    expect(CLAUDE_BOX_CONFIG_DIR).toBe(agentBoxDir('claude'));
    expect(CODEX_BOX_CONFIG_DIR).toBe(agentBoxDir('codex'));
    expect(OPENCODE_BOX_DATA_DIR).toBe(agentBoxDir('opencode'));
  });

  it('pull item lists come from each spec', () => {
    expect([...CLAUDE_PULL_DIR_CATEGORIES]).toEqual(resolveAgentSpec('claude').pull?.categories);
    const codex = resolveAgentSpec('codex').pull?.items?.find((i) => i.group === 'data');
    expect([...CODEX_PULL_ITEMS]).toEqual(codex?.names);
    const oc = resolveAgentSpec('opencode').pull?.items;
    expect([...OPENCODE_PULL_DATA_ITEMS]).toEqual(oc?.find((i) => i.group === 'data')?.names);
    expect([...OPENCODE_PULL_CONFIG_ITEMS]).toEqual(oc?.find((i) => i.group === 'config')?.names);
  });

  it('every agent that declares staticPaths also declares how to pull them', () => {
    // The gap that made `download` easy to forget when adding an agent: nothing
    // failed without it, the subcommand was simply absent.
    for (const spec of AGENT_SYNC_SPECS) {
      expect(spec.pull, `${spec.id} has no pull spec`).toBeDefined();
      const hasWork =
        (spec.pull?.items?.length ?? 0) > 0 || (spec.pull?.categories?.length ?? 0) > 0;
      expect(hasWork, `${spec.id}'s pull spec enumerates nothing`).toBe(true);
    }
  });

  it("opencode's newest-wins state root is NOT pullable", () => {
    // `update: true` is two-way newest-wins; pull is additive never-overwrite.
    // Pulling it would let a stale box copy clobber newer host state.
    const spec = resolveAgentSpec('opencode');
    const updateRoots = spec.staticPaths.filter((sp) => sp.update === true);
    expect(updateRoots.length).toBeGreaterThan(0);
    const groups = new Set(spec.pull?.items?.map((i) => i.group));
    expect(groups.has('state')).toBe(false);
    expect(spec.pull?.items?.length).toBe(2); // data + config only
  });
});
