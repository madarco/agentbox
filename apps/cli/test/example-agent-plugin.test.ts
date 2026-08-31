import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentSpecProblem, BUILTIN_AGENT_SPECS } from '@agentbox/agent-registry';

/**
 * The shipped example agent plugin must stay loadable and valid.
 *
 * It is the artifact behind the claim "adding an agent costs nothing in this
 * repo", and a doc example that has rotted proves the opposite. This loads the
 * real file the way `agentbox agent add` does — a dynamic import of the entry
 * resolved from its `package.json` — and validates the spec with the same
 * function the command uses.
 */
const PKG_DIR = join(__dirname, '..', '..', '..', 'examples', 'agentbox-agent-example');

describe('examples/agentbox-agent-example', () => {
  it('exports a spec that `agent add` would accept', async () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
      exports: { '.': { import: string } };
      agentbox?: { agentApiVersion?: number };
    };
    const entry = join(PKG_DIR, pkg.exports['.'].import);
    const mod = (await import(pathToFileURL(entry).href)) as {
      agentSpec?: unknown;
      agentSyncModule?: { id: string; resolveVolume: (o: unknown) => { volume: string } };
      AGENT_API_VERSION?: number;
    };

    expect(agentSpecProblem(mod.agentSpec)).toBeNull();
    expect(mod.AGENT_API_VERSION ?? pkg.agentbox?.agentApiVersion).toBe(1);
  });

  it('claims no built-in agent id or alias', async () => {
    // `agent add` refuses this, so an example that violated it could never be
    // registered — and would teach the wrong thing.
    const { agentSpec } = (await import(pathToFileURL(join(PKG_DIR, 'src/index.js')).href)) as {
      agentSpec: { id: string; aliases: string[] };
    };
    const taken = new Set(BUILTIN_AGENT_SPECS.flatMap((s) => [s.id, ...s.aliases]));
    for (const name of [agentSpec.id, ...agentSpec.aliases]) {
      expect(taken.has(name), `example claims built-in name "${name}"`).toBe(false);
    }
  });

  it('its docker module answers for the agent it declares', async () => {
    const mod = (await import(pathToFileURL(join(PKG_DIR, 'src/index.js')).href)) as {
      agentSpec: { id: string; dockerVolume: string };
      agentSyncModule: {
        id: string;
        resolveVolume: (o: { isolate: boolean; boxId: string }) => { volume: string };
      };
    };
    // The loader refuses a module whose id the package did not register, so a
    // mismatch here would make the example unusable rather than merely wrong.
    expect(mod.agentSyncModule.id).toBe(mod.agentSpec.id);
    expect(mod.agentSyncModule.resolveVolume({ isolate: false, boxId: 'b' }).volume).toBe(
      mod.agentSpec.dockerVolume,
    );
    expect(mod.agentSyncModule.resolveVolume({ isolate: true, boxId: 'b1' }).volume).toContain(
      'b1',
    );
  });
});
