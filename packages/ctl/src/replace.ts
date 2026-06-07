import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { parseReplacements, ReplaceError, type ReplaceRule } from '@agentbox/core';

// Re-export the pure engine (defined in @agentbox/core so the host carry path
// can share it without a dependency cycle) so in-box code keeps importing from
// a single `./replace.js` surface.
export {
  applyReplacements,
  substitutePlaceholders,
  placeholderContextFromEnv,
  parseReplaceRule,
  parseReplaceRules,
  parseReplacements,
  resolveRuleRefs,
  parseRuleArg,
  PLACEHOLDER_KEYS,
  ReplaceError,
} from '@agentbox/core';
export type { ReplaceRule, ApplyReplacementsOptions, PlaceholderKey } from '@agentbox/core';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse the top-level `replacements:` block out of raw agentbox.yaml text. */
export function parseReplacementsSection(text: string): Record<string, ReplaceRule[]> {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new ReplaceError(`yaml parse error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (doc === null || doc === undefined) return {};
  if (!isPlainObject(doc)) throw new ReplaceError('top-level config must be a mapping');
  return parseReplacements(doc.replacements);
}

/** Load the `replacements:` block from an agentbox.yaml path (missing → {}). */
export async function loadReplacementsSection(
  path: string,
): Promise<Record<string, ReplaceRule[]>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  return parseReplacementsSection(text);
}
