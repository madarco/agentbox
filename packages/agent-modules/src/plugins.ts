/**
 * Loading an INSTALLED agent's behavior — the code half of the plugin path.
 *
 * The data half needs none of this: `agent add` snapshots the spec into
 * `~/.agentbox/agents.json`, and every reader resolves it from there without
 * importing anything. That is what makes a plugin agent appear in `list`, in
 * the registry, and in every cloud provider's staging.
 *
 * Behavior is different: creating a DOCKER box for an installed agent needs its
 * `AgentSyncModule`, which only the package itself can supply. So it is loaded
 * here, through a VARIABLE `import()` of the entry path recorded at add time.
 * That variable specifier is not incidental — it is precisely why a plugin
 * agent never enters the workspace dependency graph, and so is structurally
 * exempt from the package cycle that forced the built-in data/behavior split.
 *
 * Separate from `registerAllAgentModules()` because it is async and that one is
 * not. An app that forgets this call still gets a working plugin agent for
 * everything data-driven; only a docker create fails, with
 * `requireAgentSyncModule`'s explicit message rather than a silent wrong answer.
 */

import { pathToFileURL } from 'node:url';
import { readAgentRegistrySync } from '@agentbox/agent-registry';
import { registerAgentSyncModule, type AgentSyncModule } from '@agentbox/sandbox-docker';

export interface InstalledAgentLoadResult {
  /** Agent ids whose behavior is now registered. */
  loaded: string[];
  /** Packages that could not be loaded, with the reason. */
  failed: Array<{ packageName: string; reason: string }>;
}

/**
 * Load and register the `AgentSyncModule` of every installed agent package.
 *
 * Never throws. A plugin that fails to load is reported and skipped — a broken
 * or half-uninstalled package must not take down every box command, and the
 * agent's data still resolves from the snapshot either way.
 */
export async function registerInstalledAgentModules(
  opts: {
    /**
     * Registry file to read. Defaults to `~/.agentbox/agents.json`. Overridden
     * by tests so they exercise the real dynamic `import()` — the specifier
     * being variable is the whole point, so mocking the import would test
     * nothing that matters — against a fixture package instead of the
     * developer's own installed agents.
     */
    registryPath?: string;
  } = {},
): Promise<InstalledAgentLoadResult> {
  const out: InstalledAgentLoadResult = { loaded: [], failed: [] };
  for (const record of readAgentRegistrySync(opts.registryPath).agents) {
    try {
      const mod = (await import(pathToFileURL(record.resolvedEntry).href)) as {
        agentSyncModule?: AgentSyncModule;
        agentSyncModules?: AgentSyncModule[];
      };
      const modules = mod.agentSyncModules ?? (mod.agentSyncModule ? [mod.agentSyncModule] : []);
      if (modules.length === 0) {
        // Data-only is a legitimate package: an agent whose config is purely
        // declarative needs no docker code. Not a failure, just nothing to do.
        continue;
      }
      for (const m of modules) {
        // Only for agents this package actually registered — otherwise a plugin
        // could hand back a module for `claude` and take over the built-in.
        if (!(m.id in (record.specs ?? {}))) {
          out.failed.push({
            packageName: record.packageName,
            reason: `exports a sync module for "${m.id}", which it did not register`,
          });
          continue;
        }
        registerAgentSyncModule(m);
        out.loaded.push(m.id);
      }
    } catch (err) {
      out.failed.push({
        packageName: record.packageName,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
