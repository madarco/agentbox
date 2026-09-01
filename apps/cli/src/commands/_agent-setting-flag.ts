/**
 * `--agent-setting <agent>.<key>=<value>` — the CLI face of an agent's own
 * declared settings.
 *
 * One generic flag rather than one flag per setting: which settings exist is a
 * runtime fact (`AgentSyncSpec.settings`, including an agent installed from an
 * npm package), so a commander option per setting could only ever cover the
 * built-ins. Validation is against the DECLARATION, so a typo still fails
 * loudly and an enum still lists its values.
 */

import { findAgentSpec } from '@agentbox/sandbox-core';
import type { AgentSettingsMap } from '@agentbox/sandbox-core';
import type { AgentSettingSpec } from '@agentbox/core';

/** Parse the repeated flag values, or return one error message. */
export function parseAgentSettingFlags(values: readonly string[]): AgentSettingsMap | string {
  const out: Record<string, Record<string, string | boolean>> = {};
  for (const raw of values) {
    const eq = raw.indexOf('=');
    if (eq <= 0) return `--agent-setting expects <agent>.<key>=<value>, got "${raw}"`;
    const path = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1);
    const dot = path.indexOf('.');
    if (dot <= 0 || dot === path.length - 1) {
      return `--agent-setting expects <agent>.<key>=<value>, got "${raw}"`;
    }
    const agentId = path.slice(0, dot);
    const key = path.slice(dot + 1);
    const spec = findAgentSpec(agentId);
    if (!spec) return `--agent-setting: unknown agent "${agentId}"`;
    const declared = spec.settings?.find((s) => s.key === key);
    if (!declared) {
      const known = (spec.settings ?? []).map((s) => `${spec.id}.${s.key}`);
      return known.length > 0
        ? `--agent-setting: ${spec.id} declares no setting "${key}" (known: ${known.join(', ')})`
        : `--agent-setting: ${spec.id} declares no settings`;
    }
    const coerced = coerceSetting(declared, value);
    if (typeof coerced === 'string') return `--agent-setting ${path}: ${coerced}`;
    (out[spec.id] ??= {})[key] = coerced.value;
  }
  return out;
}

function coerceSetting(
  declared: AgentSettingSpec,
  raw: string,
): { value: string | boolean } | string {
  if (declared.type === 'bool') {
    if (['true', 'yes', '1'].includes(raw.toLowerCase())) return { value: true };
    if (['false', 'no', '0'].includes(raw.toLowerCase())) return { value: false };
    return `expected a boolean, got "${raw}"`;
  }
  if (declared.type === 'enum') {
    const allowed = declared.enumValues ?? [];
    if (!allowed.includes(raw)) return `must be one of: ${allowed.join(', ')}`;
  }
  return { value: raw };
}

/**
 * CLI overrides layered onto the config-resolved settings, PER AGENT rather than
 * per agent-block: `--agent-setting claude.install=npm` must not drop the
 * `claude.tui` the project's config set.
 */
export function mergeAgentSettings(
  base: AgentSettingsMap,
  overrides: AgentSettingsMap | undefined,
): AgentSettingsMap {
  if (!overrides) return base;
  const out: Record<string, Record<string, string | boolean>> = {};
  for (const [id, values] of Object.entries(base)) out[id] = { ...values };
  for (const [id, values] of Object.entries(overrides)) out[id] = { ...out[id], ...values };
  return out;
}
