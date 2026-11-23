/**
 * Linked skill folders (docs/hub-skills-plan.md, Phase 5): folders on this PC
 * that `agentbox skills import <path> --link` tied to the hub's library. This
 * PC's relay watches each one and, on a change, runs
 * `agentbox skills import <path> --linked`, which uploads a new version — the
 * authoring loop. One file per PC, `~/.agentbox/skill-links.json`.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface SkillLink {
  /** The skill's name in the library. */
  name: string;
  /** Absolute path of the skill folder on this PC. */
  path: string;
  linkedAt: string;
}

export function skillLinksPath(home: string = homedir()): string {
  return join(home, '.agentbox', 'skill-links.json');
}

export async function readSkillLinks(home?: string): Promise<SkillLink[]> {
  try {
    const raw = JSON.parse(await readFile(skillLinksPath(home), 'utf8')) as { links?: unknown };
    const links = Array.isArray(raw.links) ? raw.links : [];
    return links.filter(
      (l): l is SkillLink =>
        !!l &&
        typeof (l as SkillLink).name === 'string' &&
        typeof (l as SkillLink).path === 'string' &&
        (l as SkillLink).path.startsWith('/'),
    );
  } catch {
    return [];
  }
}

export async function writeSkillLinks(links: readonly SkillLink[], home?: string): Promise<void> {
  const file = skillLinksPath(home);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  const sorted = [...links].sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(tmp, JSON.stringify({ links: sorted }, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}

/** Add or replace the link for `name`. */
export async function linkSkill(name: string, path: string, home?: string): Promise<void> {
  const links = (await readSkillLinks(home)).filter((l) => l.name !== name);
  links.push({ name, path, linkedAt: new Date().toISOString() });
  await writeSkillLinks(links, home);
}

/** Remove links by name. Returns the names that were linked. */
export async function unlinkSkills(names: readonly string[], home?: string): Promise<string[]> {
  const links = await readSkillLinks(home);
  const drop = new Set(names);
  const removed = links.filter((l) => drop.has(l.name)).map((l) => l.name);
  if (removed.length > 0)
    await writeSkillLinks(
      links.filter((l) => !drop.has(l.name)),
      home,
    );
  return removed;
}
