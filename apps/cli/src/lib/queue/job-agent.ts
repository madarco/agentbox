/**
 * What a queued create job's `agent` means for the box the worker builds.
 *
 * The queue's `agent` is a WIRE spelling (`'claude-code'`), and the worker used
 * to translate it with `toSyncKind` — which validates against
 * `BUILTIN_AGENT_KINDS`, the four agents compiled into `@agentbox/core`. That is
 * the wrong accept-list: `@agentbox/core` is the dependency-free leaf and has no
 * registry to ask, so anything outside those four — `openclaw`, and every
 * `agentbox agent add` plugin agent — died with `unknown agent kind` AFTER the
 * hub route had already validated it against the live registry and returned 202.
 * `resolveAgentSpec` resolves by id OR alias off the registry, so it keeps the
 * fail-closed property while accepting everything this build actually ships.
 *
 * The second thing it decides is whether the job has a SESSION leg at all.
 * There are three cases, not two:
 *
 * | job              | `agents:` | session | `recordLastAgent` |
 * |------------------|-----------|---------|-------------------|
 * | `noAgent`        | `[]`      | none    | no                |
 * | TUI agent        | `[id]`    | tmux    | yes               |
 * | **service agent**| `[id]`    | none    | yes               |
 *
 * A service agent is a daemon ctl's supervisor runs: the units are synthesized
 * in-box from the `agents.list` payload when the supervisor starts, so the host
 * has nothing to launch after create. Gated on `caps.surface` via
 * {@link isServiceAgent}, never on an agent id.
 */
import { isServiceAgent, type AgentSyncSpec } from '@agentbox/core';
import { resolveAgentSpec } from '@agentbox/sandbox-core';

export interface JobAgentPlan {
  /** The resolved registry row, or undefined for a `noAgent` job. */
  spec?: AgentSyncSpec;
  /**
   * The agents the box is built FOR — authoritative, so the box carries only
   * this agent's config volume, credentials and home dir.
   */
  agents: string[];
  /** Does the worker start an agent session after create? */
  startsSession: boolean;
}

/**
 * The wire kinds the worker's session dispatch actually implements — the `if /
 * else if` chains in `_run-queued-job.ts` (docker `runDockerJob`, cloud
 * `runCloudJob`), which end in a `throw`.
 *
 * NOT "the agents this build ships", and deliberately not derived from the
 * registry: it is a statement about the WORKER, and it is narrower than the
 * registry on purpose. `example` is a real, hidden, built-in TUI agent with a
 * working CLI module, and it is absent here because those chains have no branch
 * for it — the canary doing its job. So is every `agentbox agent add` TUI agent.
 *
 * Deleting this list is the goal. It goes away when the dispatch drives
 * `AgentRuntime` (`@agentbox/cli-kit`) instead of branching on the id, which
 * needs the contract to carry two things it does not today: claude's
 * `agentSettings` and its `rebuildPluginNativeDeps` pre-step. Tracked in
 * `docs/plans/service-boxes-backlog.md`.
 */
const QUEUE_LAUNCHABLE_KINDS = ['claude', 'codex', 'opencode', 'pi'];

/**
 * Resolve a queued job's agent, or throw naming what is missing.
 *
 * Throwing HERE is the point. Both runners call this before `createBox`, so an
 * agent the worker cannot finish costs nothing; the dispatch chain's own throw
 * fires AFTER the box exists, failing the job and leaving that box behind. That
 * was invisible while the resolution gate was `toSyncKind` — it refused the same
 * agents, just earlier. Widening resolution to the registry (which is correct,
 * and what lets `openclaw` through) is what exposed the ordering.
 */
export function planJobAgent(job: { noAgent?: boolean; agent: string }): JobAgentPlan {
  if (job.noAgent) return { agents: [], startsSession: false };
  const spec = resolveAgentSpec(job.agent);
  const startsSession = !isServiceAgent(spec);
  if (startsSession && !QUEUE_LAUNCHABLE_KINDS.includes(spec.id)) {
    throw new Error(
      `${spec.id} cannot be started by a queued create: the worker has no session launcher ` +
        `for it. Make the box with \`agentbox create\`, then start the agent in it with ` +
        `\`agentbox ${spec.id} <box>\`.`,
    );
  }
  return { spec, agents: [spec.id], startsSession };
}
