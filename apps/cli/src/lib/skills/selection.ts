/**
 * The create flags that pick a box's share of the hub's skills library
 * (docs/hub-skills-plan.md, Phase 2), shared by `agentbox create` and every
 * `agentbox <agent>`:
 *
 *   --skills <names>       only these (comma-separated, repeatable)
 *   --skip-skills <names>  every library skill but these
 *   --no-skills            none
 *
 * Not `--skill`/`--no-skill <names>` as the plan sketched: commander reads
 * `--no-X` as the negation of `--X`, so the pair can't both carry values.
 */
import type { SkillSelection } from '@agentbox/core';

export interface SkillFlagOptions {
  /** `--skills a,b` → names; `--no-skills` → false. */
  skills?: string[] | false;
  skipSkills?: string[];
}

/** Commander collector for the `--skills` / `--skip-skills` name lists. */
export function collectSkillNames(value: string, prev: string[] | undefined): string[] {
  return [
    ...(prev ?? []),
    ...value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ];
}

export const SKILL_FLAG_HELP = {
  skills: "give the box only these skills from the hub's library (comma-separated, repeatable)",
  noSkills: "give the box none of the hub's library skills",
  skipSkills: 'give the box every library skill except these (comma-separated, repeatable)',
} as const;

/** The selection to record on the box; undefined = every library skill (the default). */
export function skillSelectionFromFlags(opts: SkillFlagOptions): SkillSelection | undefined {
  if (opts.skills === false) return { none: true };
  const out: SkillSelection = {};
  if (Array.isArray(opts.skills) && opts.skills.length > 0) out.include = [...opts.skills];
  if (opts.skipSkills && opts.skipSkills.length > 0) out.exclude = [...opts.skipSkills];
  return Object.keys(out).length > 0 ? out : undefined;
}
