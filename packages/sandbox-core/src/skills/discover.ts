/**
 * This PC's skills: what the automatic seed uploads and what `agentbox skills`
 * shows in its "local" column.
 *
 * The user-level skill dirs the five built-in agents read (measured in
 * docs/hub-skills-plan.md, Phase 0). A CLI constant for Phase 1; Phase 2 moves
 * it onto the agent registry (`AgentSyncSpec.skills.dirs`) so a plugin agent's
 * dir is found too. `~/.agents/skills` comes first: it is the cross-agent
 * location, and on a typical Mac `~/.claude/skills/<x>` is a link into it.
 */
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { parseSkillFrontmatter } from './frontmatter.js';
import { scanSkillFiles, type SecretFinding } from './scan.js';
import { readSkillTree, SkillTooLargeError, treeHash, type SkillFile } from './tree.js';

export const LOCAL_SKILL_DIRS: readonly string[] = [
  '.agents/skills',
  '.claude/skills',
  '.codex/skills',
  '.config/opencode/skills',
  '.pi/agent/skills',
  '.openclaw/skills',
];

/**
 * Claude Code's claude.ai-synced skills (`~/.claude/skills/synced/<org>_<id>/…`):
 * managed and re-synced by Claude Code itself, never seeded (plan decision 8).
 */
const CLAUDE_SYNCED_DIR = '.claude/skills/synced';
/** AgentBox's own skills (`/agentbox`, `agentbox-*`) are installed by AgentBox itself everywhere. */
function isReserved(name: string): boolean {
  return name === 'agentbox' || name.startsWith('agentbox-');
}
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface LocalSkill {
  name: string;
  /** The directory read (first location found). */
  dir: string;
  description: string;
  /** Tree hash of `files`; empty when the tree couldn't be read. */
  treeSha: string;
  files: SkillFile[];
  size: number;
  newestMtimeMs: number;
  /** Why it can't be uploaded as is. Empty = uploadable. */
  problems: string[];
  findings: SecretFinding[];
  /** Other locations holding a skill of the same name, and whether their content matches. */
  alsoAt: { dir: string; same: boolean }[];
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * SKILL.md's text, or '' when it can't be read safely: only a regular file
 * inside the skill, up to `maxBytes`. A SKILL.md that is a link to `/dev/zero`
 * or a FIFO (both easy to plant in a box) would otherwise be read forever, and
 * one linking out of the skill would read a file the skill doesn't hold.
 */
async function readSkillMd(dir: string, skill: LocalSkill, maxBytes?: number): Promise<string> {
  const path = join(dir, 'SKILL.md');
  const st = await stat(path).catch(() => null);
  if (!st) return '';
  if (!st.isFile()) {
    skill.problems.push('SKILL.md is not a regular file');
    return '';
  }
  const [real, root] = await Promise.all([realpath(path), realpath(dir)]).catch(() => ['', '']);
  if (!real || !real.startsWith(root + sep)) {
    skill.problems.push('SKILL.md links outside the skill');
    return '';
  }
  if (maxBytes !== undefined && st.size > maxBytes) {
    skill.problems.push(`SKILL.md is over the ${String(maxBytes)}-byte cap`);
    return '';
  }
  return readFile(path, 'utf8').catch(() => '');
}

/** Read one skill directory into a {@link LocalSkill} (no discovery rules applied). */
export async function readLocalSkill(
  name: string,
  dir: string,
  opts: { maxBytes?: number } = {},
): Promise<LocalSkill> {
  const skill: LocalSkill = {
    name,
    dir,
    description: '',
    treeSha: '',
    files: [],
    size: 0,
    newestMtimeMs: 0,
    problems: [],
    findings: [],
    alsoAt: [],
  };
  if (!SKILL_NAME_RE.test(name)) {
    skill.problems.push('name must be lowercase letters, digits and hyphens (max 64)');
  }
  const fm = parseSkillFrontmatter(await readSkillMd(dir, skill, opts.maxBytes));
  if (!fm) {
    skill.problems.push('SKILL.md has no frontmatter');
  } else {
    if (fm.name !== name)
      skill.problems.push(`frontmatter name '${fm.name ?? ''}' != folder '${name}'`);
    if (!fm.description) skill.problems.push('frontmatter has no description');
    skill.description = fm.description ?? '';
  }
  try {
    const tree = await readSkillTree(dir, opts);
    skill.files = tree.files;
    skill.size = tree.size;
    skill.newestMtimeMs = tree.newestMtimeMs;
    skill.treeSha = treeHash(tree.files);
    for (const l of tree.brokenLinks) skill.problems.push(`broken symlink: ${l}`);
    for (const l of tree.outOfTreeLinks) {
      skill.problems.push(`symlink points outside the skill: ${l}`);
    }
    skill.findings = scanSkillFiles(tree.files);
  } catch (err) {
    if (err instanceof SkillTooLargeError) {
      skill.problems.push(
        `over the size cap (${String(err.maxBytes)} bytes, skills.maxSkillBytes)`,
      );
    } else {
      skill.problems.push(`unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return skill;
}

/**
 * Every skill in {@link LOCAL_SKILL_DIRS}, one per name (first location wins;
 * the rest are listed in `alsoAt`). Skips dot-names, `agentbox` / `agentbox-*`, claude's
 * `synced/` tree, and folders with no SKILL.md.
 */
export async function discoverLocalSkills(
  opts: { home?: string; maxBytes?: number } = {},
): Promise<LocalSkill[]> {
  const home = opts.home ?? homedir();
  const byName = new Map<string, LocalSkill>();
  for (const rel of LOCAL_SKILL_DIRS) {
    const root = join(home, rel);
    let names: string[];
    try {
      names = (await readdir(root)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.') || isReserved(name)) continue;
      const dir = join(root, name);
      if (join(rel, name) === CLAUDE_SYNCED_DIR) continue;
      if (!(await isDir(dir)) || !(await exists(join(dir, 'SKILL.md')))) continue;
      const first = byName.get(name);
      if (first) {
        // The usual Mac layout links `~/.claude/skills/<x>` into `~/.agents/skills/<x>`:
        // the same directory, so no need to read and scan it a second time.
        const [a, b] = await Promise.all([
          realpath(first.dir).catch(() => first.dir),
          realpath(dir).catch(() => dir),
        ]);
        if (a === b) {
          first.alsoAt.push({ dir, same: true });
          continue;
        }
        const other = await readLocalSkill(name, dir, opts);
        first.alsoAt.push({ dir, same: other.treeSha !== '' && other.treeSha === first.treeSha });
        continue;
      }
      byName.set(name, await readLocalSkill(name, dir, opts));
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
