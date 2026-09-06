/**
 * Which config volume an agent gets in a new box: the shared one, or a per-box
 * one.
 *
 * The default is the AGENT's, not a flat `false`. A `caps.surface: 'service'`
 * agent always isolates: its config dir holds a gateway's identity and its
 * pairings, so two daemons sharing one would answer as the same gateway — the
 * one thing the product cannot allow. Deriving it here, where `createBox`
 * applies it, is what makes every caller inherit it: the CLI's `agentbox
 * <agent>` used to force `isolate: true` at its own call site, so the hub's
 * queue worker (and the tray, and anything built next) would each have had to
 * remember the same line.
 *
 * `config` does not even generate a `box.isolate<Agent>Config` key for a
 * service agent, exactly so there is no switch that could turn this off from a
 * config file. An explicitly-passed option is still honored — the caller keeps
 * the last word — but it is warned about, because the consequence is not
 * something a setting name conveys.
 */
import { isServiceAgent, type AgentSyncSpec } from '@agentbox/core';

export interface AgentIsolationOptions {
  claudeConfig?: { isolate: boolean };
  codexConfig?: { isolate: boolean };
  opencodeConfig?: { isolate: boolean };
  agentConfig?: Record<string, { isolate?: boolean }>;
}

export function resolveAgentIsolation(
  spec: AgentSyncSpec,
  opts: AgentIsolationOptions,
  log: (line: string) => void = () => {},
): boolean {
  // The three named options win; `agentConfig` carries every other agent's.
  // This used to `return false` for anything but the three, so a fourth or
  // plugin agent could never isolate no matter what its config key said.
  if (spec.id === 'claude' && opts.claudeConfig) return opts.claudeConfig.isolate;
  if (spec.id === 'codex' && opts.codexConfig) return opts.codexConfig.isolate;
  if (spec.id === 'opencode' && opts.opencodeConfig) return opts.opencodeConfig.isolate;
  const explicit = opts.agentConfig?.[spec.id]?.isolate;
  if (explicit === false && isServiceAgent(spec)) {
    log(
      `warning: ${spec.id} is a service agent but this box will share the ${spec.dockerVolume} config volume — its gateway identity and pairings will be the same as every other ${spec.id} box's`,
    );
  }
  return explicit ?? isServiceAgent(spec);
}
