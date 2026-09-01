/**
 * Reading one agent's declared settings out of the effective config.
 *
 * The whole point of the mechanism is that no shared code knows what a setting
 * MEANS, so every consumer goes through here and gets an opaque bag. Which keys
 * exist is the agent's declaration; the defaults are already materialised into
 * `EffectiveConfig` by `BUILT_IN_DEFAULTS` + `perAgentDefaults`, so this is a
 * projection, not a second defaulting layer.
 */

import { loadEffectiveConfig } from './load.js';
import type { AgentSettings, EffectiveConfig } from './types.js';

/**
 * The `<agentId>.*` block, minus the two leaves that exist for every agent and
 * are read directly by name (`sessionName`, `dangerouslySkipPermissions`).
 * An agent with no block — a plugin agent that declared no settings — yields {}.
 */
export function agentSettings(cfg: EffectiveConfig, agentId: string): AgentSettings {
  const block = (cfg as unknown as Record<string, unknown>)[agentId];
  if (!block || typeof block !== 'object') return {};
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
    if (key === 'sessionName' || key === 'dangerouslySkipPermissions') continue;
    if (typeof value === 'string' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/** Every agent's settings, keyed by id — the shape carried by prepare/create. */
export function allAgentSettings(cfg: EffectiveConfig): Record<string, AgentSettings> {
  const out: Record<string, AgentSettings> = {};
  for (const [key, value] of Object.entries(cfg as unknown as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    // An agent block is exactly the one carrying `sessionName`; `box`, `git`,
    // `attach` and the rest do not. Cheaper and more robust than importing the
    // agent id list, which would miss a plugin agent anyway.
    if (typeof (value as Record<string, unknown>)['sessionName'] !== 'string') continue;
    const settings = agentSettings(cfg as EffectiveConfig, key);
    if (Object.keys(settings).length > 0) out[key] = settings;
  }
  return out;
}

/**
 * One agent's settings for a project, resolved from disk.
 *
 * `workspacePath` is the BOX's workspace, never `process.cwd()`: the queue
 * worker runs from the state dir and takes the workspace from the job manifest,
 * and `agentbox config set` writes `--project` by default — so a cwd-based load
 * would read globals and miss the project's own setting.
 *
 * Never throws. A setting is a preference; a config that cannot be read must not
 * be able to stop a session starting or a bake running, so an unreadable config
 * degrades to the declared defaults.
 */
export async function agentSettingsFor(
  agentId: string,
  workspacePath?: string,
): Promise<AgentSettings> {
  try {
    const cfg = await loadEffectiveConfig(workspacePath ?? process.cwd());
    return agentSettings(cfg.effective, agentId);
  } catch {
    return {};
  }
}
