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

/** Resolve a queued job's agent, or throw naming the agent the registry lacks. */
export function planJobAgent(job: { noAgent?: boolean; agent: string }): JobAgentPlan {
  if (job.noAgent) return { agents: [], startsSession: false };
  const spec = resolveAgentSpec(job.agent);
  return { spec, agents: [spec.id], startsSession: !isServiceAgent(spec) };
}
