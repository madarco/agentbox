import { readFile } from 'node:fs/promises';
import { parse as parseYaml, parseDocument } from 'yaml';
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

/**
 * Remove one named rule-set from an `agentbox.yaml` document, and any comment
 * line carrying `sentinel`.
 *
 * Exists for `agentbox clone`. A bot's `identity` rules name the SOURCE bot
 * ("rewrite Ada to this box's name"), so copying them into a clone leaves rules
 * that match a name the clone's own files no longer contain — the NEXT clone
 * then rewrites nothing and keeps introducing itself as its grandparent. The
 * sentinel goes with them, because it is what stops the box facts nudging the
 * new bot to write rules of its own.
 *
 * Document surgery rather than a re-serialize: `agentbox.yaml` is the user's
 * file, and a clone has no business reformatting the rest of it or dropping
 * their comments. Returns the text unchanged when there is nothing to remove.
 */
export function removeReplacementsSet(text: string, name: string, sentinel?: string): string {
  let out = text;
  let doc;
  try {
    doc = parseDocument(text);
  } catch {
    return text; // not our file to fix
  }
  // `parseDocument` does NOT throw on malformed yaml -- it collects errors and
  // then refuses to stringify, which would take a clone down over a file the
  // user broke. Leave theirs exactly as it is.
  if (doc.errors.length > 0) return text;
  if (doc.hasIn(['replacements', name])) {
    doc.deleteIn(['replacements', name]);
    const rest = doc.getIn(['replacements']);
    // An emptied `replacements:` would serialize as a null key, which the
    // parser then rejects as a malformed section.
    if (isEmptyMap(rest)) doc.delete('replacements');
    out = String(doc);
  }
  if (sentinel) {
    out = out
      .split('\n')
      .filter((line) => !(line.trimStart().startsWith('#') && line.includes(sentinel)))
      .join('\n');
  }
  return out;
}

/** True for a yaml map node with no entries left. */
function isEmptyMap(node: unknown): boolean {
  return (
    typeof node === 'object' &&
    node !== null &&
    'items' in node &&
    Array.isArray((node as { items: unknown[] }).items) &&
    (node as { items: unknown[] }).items.length === 0
  );
}
