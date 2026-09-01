/**
 * The settings declared by agents installed from an npm package.
 *
 * WHY THIS DUPLICATES A READ THAT ALREADY EXISTS. `@agentbox/agent-registry`
 * reads the same file into full `AgentSyncSpec`s, but it depends on
 * `@agentbox/config`, so config cannot ask it. Config needs one narrow fact —
 * which `<agent>.<setting>` keys exist — so it reads the same file for that and
 * nothing else. `AGENTS_FILE` is shared (see `paths.ts`), so the path itself is
 * not duplicated.
 *
 * Degrades to nothing on ANY problem: a missing file, unreadable JSON, a
 * hand-edited entry. An unaddressable setting is a bad day; a config layer that
 * throws on load bricks every command.
 */

import { readFileSync } from 'node:fs';
import { AGENTS_FILE } from './paths.js';
import type { AgentConfigSetting } from './agents.js';

/** One installed agent's contribution to the key registry. */
export interface PluginAgentSettings {
  readonly id: string;
  readonly settings: readonly AgentConfigSetting[];
}

function isSetting(v: unknown): v is AgentConfigSetting {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (typeof s['key'] !== 'string' || s['key'].length === 0) return false;
  // A dotted leaf would generate `agent.a.b`, which the parser reads as a
  // nested branch that nothing materialises.
  if (s['key'].includes('.')) return false;
  if (s['type'] !== 'string' && s['type'] !== 'bool' && s['type'] !== 'enum') return false;
  if (s['type'] === 'enum') {
    const vals = s['enumValues'];
    if (!Array.isArray(vals) || vals.length === 0 || vals.some((x) => typeof x !== 'string')) {
      return false;
    }
    if (typeof s['default'] !== 'string' || !(vals as string[]).includes(s['default']))
      return false;
  } else if (typeof s['default'] !== (s['type'] === 'bool' ? 'boolean' : 'string')) {
    return false;
  }
  return typeof s['description'] === 'string';
}

/**
 * Read the installed agents' declared settings.
 *
 * Resolved once at module load by the key registry, exactly like
 * `AGENT_SPECS`: ~40 readers treat the registry as a constant, and an agent
 * appearing halfway through a command would be far worse than one that appears
 * on the next. Every CLI invocation is a fresh process.
 */
export function pluginAgentSettings(path: string = AGENTS_FILE): PluginAgentSettings[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const agents = (parsed as Record<string, unknown>)['agents'];
  if (!Array.isArray(agents)) return [];

  const out: PluginAgentSettings[] = [];
  const seen = new Set<string>();
  for (const record of agents) {
    if (!record || typeof record !== 'object') continue;
    const specs = (record as Record<string, unknown>)['specs'];
    if (!specs || typeof specs !== 'object') continue;
    for (const [id, spec] of Object.entries(specs as Record<string, unknown>)) {
      if (seen.has(id) || !spec || typeof spec !== 'object') continue;
      const declared = (spec as Record<string, unknown>)['settings'];
      if (!Array.isArray(declared)) continue;
      const settings = declared.filter(isSetting);
      if (settings.length === 0) continue;
      seen.add(id);
      out.push({ id, settings });
    }
  }
  return out;
}
