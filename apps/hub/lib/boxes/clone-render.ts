/**
 * The identity half of a clone: rewrite the new bot's own name into the files
 * its agent declared as `clone.render` (openclaw's `SOUL.md`, `IDENTITY.md`).
 *
 * Host-side, once, in the exported directory — NOT in the box. The rule-set
 * lives in the workspace's `agentbox.yaml`, which the export has already put on
 * disk, and the export dir becomes the clone's project before the box exists.
 * Rendering here also makes Decision 6 ("a generated file is rendered only when
 * absent") true by construction: after the clone these are ordinary workspace
 * files, so a bot that rewrites its own `SOUL.md` is never reset by a reboot.
 *
 * The rule-set is named `identity` by convention and is written by the bot
 * itself through the `/agentbox-identity` skill. Its absence is normal (a
 * workspace whose bot has not run the wizard yet) and must not fail a clone:
 * the files are copied verbatim and the caller says so.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyReplacements,
  resolveRuleRefs,
  IDENTITY_RULE_SET,
  IDENTITY_RULES_SENTINEL,
  type ReplaceRule,
} from '@agentbox/core';
import { parseReplacementsSection, removeReplacementsSet } from '@agentbox/ctl';

export interface CloneRenderArgs {
  /** The exported workspace (the clone's project root). */
  dir: string;
  /** Workspace-relative paths from the agent's `clone.render`. */
  paths: readonly string[];
  /** The new box's name — what `{{AGENTBOX_BOX_NAME}}` renders to. */
  boxName: string;
  onLog?: (line: string) => void;
}

export interface CloneRenderResult {
  /** Files whose content actually changed. */
  rendered: string[];
  /** Declared but absent in the export — normal, not an error. */
  skipped: string[];
  /** True when the workspace declared an `identity` rule-set. */
  hadRules: boolean;
  /** True when that rule-set was stripped from the clone's own yaml. */
  clearedRules: boolean;
}

/**
 * Read the workspace's `identity` rule-set, if it has one.
 *
 * A malformed `replacements:` block is reported, not thrown: the user's yaml
 * should not be able to make `clone` fail with a parse error deep in the hub,
 * and the placeholder pass below is still worth running without it.
 */
async function identityRules(dir: string, onLog?: (line: string) => void): Promise<ReplaceRule[]> {
  let text: string;
  try {
    text = await readFile(path.join(dir, 'agentbox.yaml'), 'utf8');
  } catch {
    return [];
  }
  try {
    const sets = parseReplacementsSection(text);
    if (!(IDENTITY_RULE_SET in sets)) return [];
    return resolveRuleRefs([IDENTITY_RULE_SET], sets, 'clone');
  } catch (err) {
    onLog?.(
      `clone: ignoring the replacements: block (${err instanceof Error ? err.message : String(err)})`,
    );
    return [];
  }
}

/**
 * Take the source bot's identity rules OUT of the clone's own `agentbox.yaml`.
 *
 * They say "rewrite Ada to this box's name". Once this clone's files say `bea`,
 * that rule matches nothing — so a clone OF the clone would rewrite nothing and
 * keep introducing itself as its grandparent, and the sentinel would stop the
 * box facts from ever nudging it to write rules of its own. Removing both is
 * what makes the next generation self-correcting.
 */
async function clearIdentityRules(dir: string): Promise<boolean> {
  const path_ = path.join(dir, 'agentbox.yaml');
  let before: string;
  try {
    before = await readFile(path_, 'utf8');
  } catch {
    return false;
  }
  const after = removeReplacementsSet(before, IDENTITY_RULE_SET, IDENTITY_RULES_SENTINEL);
  if (after === before) return false;
  await writeFile(path_, after, 'utf8');
  return true;
}

/**
 * Render the agent's identity files for the new box.
 *
 * Runs the placeholder pass even with no rule-set, so a workspace that writes
 * `{{AGENTBOX_BOX_NAME}}` into `SOUL.md` by hand works without one.
 */
export async function renderCloneIdentity(args: CloneRenderArgs): Promise<CloneRenderResult> {
  const rendered: string[] = [];
  const skipped: string[] = [];
  if (args.paths.length === 0) return { rendered, skipped, hadRules: false, clearedRules: false };

  const rules = await identityRules(args.dir, args.onLog);
  const context = { AGENTBOX_BOX_NAME: args.boxName };
  const clearedRules = rules.length > 0 ? await clearIdentityRules(args.dir) : false;

  for (const rel of args.paths) {
    const abs = path.join(args.dir, rel);
    let before: string;
    try {
      before = await readFile(abs, 'utf8');
    } catch {
      skipped.push(rel);
      continue;
    }
    const after = applyReplacements(before, { env: true, rules, context });
    if (after === before) continue;
    await writeFile(abs, after, 'utf8');
    rendered.push(rel);
  }
  return { rendered, skipped, hadRules: rules.length > 0, clearedRules };
}
