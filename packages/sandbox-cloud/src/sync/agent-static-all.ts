/**
 * Stage every agent's static config for a cloud bake.
 *
 * Lives here rather than in `sandbox-core` because the per-agent stagers do:
 * claude's filters host-path hooks and codex's sanitizes `config.toml`, so both
 * belong in their own packages — and an agent package depends on `sandbox-core`,
 * which cannot import it back. `AgentCloudModule` is the seam that was already
 * here, and `stageStatic` was already on it.
 *
 * What stayed in `sandbox-core` is the part with no agent in it: the generic
 * `stageAgentStaticForUpload`, which stages any agent from its `staticPaths`
 * alone, and the rsync/tar primitives underneath it.
 */

import {
  AGENT_SYNC_SPECS,
  stageAgentStaticForUpload,
  stageAgentsStaticForUpload,
  AGENTS_STATIC_BOX_DIR,
  type AgentStaticStage,
} from '@agentbox/sandbox-core';
import { agentCloudModule } from './agent-cloud-module.js';

export async function stageAllAgentStatic(
  opts: {
    hostWorkspace?: string;
    /**
     * Which agents to stage. Absent = all, the historical behaviour.
     *
     * `~/.agents` is never filtered: it is the shared skills tree, not an
     * agent's auth or config, and every agent reads it.
     *
     * Staging is a PREPARE-time concern — this bakes host config into the
     * snapshot — which is why the selection has to reach `PrepareOptions` and
     * not only `create`.
     */
    agents?: readonly string[];
    /**
     * Defaults to `homedir()`. Threaded through every stager so a test can
     * point the whole thing at a fixture home instead of the developer's own —
     * without it, the only way to exercise this is to rsync a real `~/.claude`.
     */
    hostHome?: string;
  } = {},
): Promise<AgentStaticStage[]> {
  const wanted = opts.agents ? new Set<string>(opts.agents) : undefined;
  const specs = AGENT_SYNC_SPECS.filter((spec) => !wanted || wanted.has(spec.id));

  const staged = await Promise.all(
    specs.map(async (spec) => {
      // An agent whose staging is more than a copy of its declared paths
      // supplies its own on its cloud module — claude filters host-path hooks,
      // codex sanitizes config.toml. Everything else takes the generic stager,
      // which is the point: an agent added tomorrow reaches every provider's
      // snapshot from its registry row, with nothing registered here.
      const dedicated = agentCloudModule(spec.id)?.stageStatic;
      const result = dedicated
        ? await dedicated({ hostWorkspace: opts.hostWorkspace })
        : await stageAgentStaticForUpload(spec.id, { hostHome: opts.hostHome });
      // `staticPaths[0].boxDir` is the extract root for every source of an
      // agent: the relocations inside the tarball are relative to it.
      const extractDir = spec.staticPaths[0]?.boxDir;
      return extractDir ? { kind: spec.id, extractDir, staged: result } : null;
    }),
  );

  const out: AgentStaticStage[] = staged.filter((s): s is AgentStaticStage => s !== null);
  out.push({
    kind: 'agents',
    extractDir: AGENTS_STATIC_BOX_DIR,
    staged: await stageAgentsStaticForUpload({ hostHome: opts.hostHome }),
  });
  return out;
}
