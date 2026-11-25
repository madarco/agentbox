/**
 * A PC's side of the hub <-> PC skills sync (docs/hub-settings-plan.md, Phase 2):
 * the inventory the hub compares against, reading one skill out for the hub
 * ("Pull to Hub"), and installing a hub skill on disk ("Send to <machine>").
 *
 * Shared by the CLI's `agentbox skills` TUI (which talks to the hub itself) and
 * the PC relay's `pcskills.*` host actions (which the hub reaches through
 * host-reach routing), so both land a skill the same way.
 */
import { randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { agentSkillDirs, agentsForSkillDirs, type AgentSkillDirs } from './compare.js';
import { discoverLocalSkills, SKILL_NAME_RE, type LocalSkill } from './discover.js';
import { readSkillTree, treeHash } from './tree.js';
import type { TarFile } from './tar.js';

/** The cross-agent skills dir: where installs land. */
export const AGENTS_SKILLS_DIR = '.agents/skills';

/** One PC skill as the hub sees it. No file contents. */
export interface PcSkill {
  name: string;
  description: string;
  /** Tree hash; empty when the tree could not be read. */
  treeSha: string;
  newestMtimeMs: number;
  size: number;
  files: number;
  /** Home-relative skill dirs holding it (first = the copy read). */
  dirs: string[];
  /** Absolute path of the copy read. */
  path: string;
  /** Agents that read it on this PC (from the registry's `skills.dirs`). */
  agents: string[];
  /** Why it can't be uploaded as is. */
  problems: string[];
  /** Secret-scan hits (rule and file only, never the match). */
  findings: { rule: string; path: string; line: number }[];
  /** Another dir holds a different skill of the same name. */
  conflicting?: boolean;
}

export interface PcSkillsInventory {
  skills: PcSkill[];
}

function homeRel(home: string, p: string): string {
  const r = relative(home, p);
  return r.startsWith('..') ? p : r.split(sep).join('/');
}

export function toPcSkill(
  s: LocalSkill,
  home: string,
  agents: readonly AgentSkillDirs[] = agentSkillDirs(),
): PcSkill {
  const dirs = [s.dir, ...s.alsoAt.map((a) => a.dir)].map((d) => homeRel(home, dirname(d)));
  const conflicting = s.alsoAt.some((a) => !a.same);
  return {
    name: s.name,
    description: s.description,
    treeSha: s.treeSha,
    newestMtimeMs: s.newestMtimeMs,
    size: s.size,
    files: s.files.length,
    dirs,
    path: s.dir,
    agents: agentsForSkillDirs(dirs, agents),
    problems: s.problems,
    findings: s.findings.map((f) => ({ rule: f.rule, path: f.path, line: f.line })),
    ...(conflicting ? { conflicting: true } : {}),
  };
}

/** Every skill in this PC's agent skill dirs, with tree hashes. */
export async function pcSkillsInventory(
  opts: { home?: string; maxBytes?: number } = {},
): Promise<PcSkillsInventory> {
  const home = opts.home ?? homedir();
  const local = await discoverLocalSkills({
    home,
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  });
  const agents = agentSkillDirs();
  return { skills: local.map((s) => toPcSkill(s, home, agents)) };
}

/** One PC skill's files, for an upload to the hub; null when this PC has none of that name. */
export async function readPcSkill(
  name: string,
  opts: { home?: string; maxBytes?: number } = {},
): Promise<LocalSkill | null> {
  const local = await discoverLocalSkills({
    home: opts.home ?? homedir(),
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  });
  return local.find((s) => s.name === name) ?? null;
}

/** Why a PC skill can't be uploaded without an override, or null. */
export function uploadBlocker(
  skill: Pick<LocalSkill, 'problems' | 'findings'>,
  opts: { allowFindings?: boolean } = {},
): string | null {
  if (skill.problems.length > 0) return skill.problems.join('; ');
  if (skill.findings.length > 0 && !opts.allowFindings) {
    const where = skill.findings
      .slice(0, 3)
      .map((f) => `${f.rule} in ${f.path}:${String(f.line)}`)
      .join(', ');
    const more = skill.findings.length > 3 ? ` (+${String(skill.findings.length - 3)} more)` : '';
    return `secret scan: ${where}${more}`;
  }
  return null;
}

export type InstallOutcome =
  | {
      name: string;
      status: 'installed' | 'replaced' | 'unchanged';
      dir: string;
      /** Links made for agents that don't read `~/.agents/skills`. */
      links?: string[];
      /** A separate, different copy left in an agent's own dir (that agent still reads it). */
      kept?: string[];
    }
  | { name: string; status: 'skipped'; reason: string };

/** Where installs land: `~/.agents/skills/<name>`. */
export function agentsSkillDir(home: string, name: string): string {
  return join(home, ...AGENTS_SKILLS_DIR.split('/'), name);
}

/**
 * The home-relative dirs to link an installed skill into: the first dir of each
 * agent that does not read `~/.agents/skills` (claude, among the built-ins).
 */
export function linkDirsForAgents(agents: readonly AgentSkillDirs[] = agentSkillDirs()): string[] {
  const out = new Set<string>();
  for (const a of agents) {
    if (a.dirs.includes(AGENTS_SKILLS_DIR) || a.dirs.length === 0) continue;
    out.add(a.dirs[0]!);
  }
  return [...out];
}

async function lstatOrNull(p: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

/**
 * Point `~/<dir>/<name>` at the installed copy, for an agent that doesn't read
 * `~/.agents/skills`. Only when that agent is set up here (the dir holding its
 * skills dir, e.g. `~/.claude`, exists).
 *
 * Never deletes a real directory: a separate copy with different content is the
 * user's. It is reported back (`kept`) so the caller can say that agent still
 * reads the old one. A stale symlink is re-pointed with `overwrite` (removing a
 * link loses nothing). The link is absolute, so it resolves even when the agent's
 * dir is itself a link.
 */
async function linkInto(
  home: string,
  rel: string,
  name: string,
  target: string,
  overwrite: boolean,
): Promise<{ link?: string; kept?: string }> {
  // The agent counts as set up when the dir holding its skills dir exists
  // (`~/.claude` for `.claude/skills`, `~/.config/foo` for `.config/foo/skills`).
  const parts = rel.split('/');
  const agentRoot = parts.length > 1 ? parts.slice(0, -1) : parts;
  // `stat`, not `lstat`: a dotfile manager often makes `~/.claude` itself a link.
  const agentHome = await stat(join(home, ...agentRoot)).catch(() => null);
  if (!agentHome?.isDirectory()) return {};
  const link = join(home, ...rel.split('/'), name);
  const st = await lstatOrNull(link);
  if (st?.isSymbolicLink()) {
    if (resolve(dirname(link), await readlink(link)) === target) return { link };
    if (!overwrite) return { kept: link };
    await rm(link, { force: true });
  } else if (st) {
    const existing = await readSkillTree(link).catch(() => null);
    const same =
      existing !== null &&
      treeHash(existing.files) === treeHash((await readSkillTree(target)).files);
    return same ? { link } : { kept: link };
  }
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link);
  return { link };
}

async function linkAll(
  home: string,
  name: string,
  target: string,
  overwrite: boolean,
  linkDirs: readonly string[],
): Promise<{ links?: string[]; kept?: string[] }> {
  const links: string[] = [];
  const kept: string[] = [];
  for (const rel of linkDirs) {
    const r = await linkInto(home, rel, name, target, overwrite);
    if (r.link) links.push(r.link);
    if (r.kept) kept.push(r.kept);
  }
  return { ...(links.length ? { links } : {}), ...(kept.length ? { kept } : {}) };
}

/**
 * Install a skill's files at `~/.agents/skills/<name>`. The files' tree hash must
 * equal `version` (what the hub named), so what lands is exactly what was
 * uploaded. An existing copy with different content is replaced only with
 * `overwrite`. Written next to the target under a dot-name (discovery skips
 * those) and swapped in, so a failed install never leaves a half-written skill.
 */
/** What {@link installSkillFiles} would do, read before asking anyone. */
export interface InstallCheck {
  action: 'install' | 'replace' | 'unchanged' | 'skip';
  /** `~/.agents/skills/<name>`. */
  target: string;
  /** The target's real path when it (or a dir above it) is a link. */
  realTarget?: string;
}

/**
 * Look at what an install of `version` would do, without writing: a confirm
 * asks only for an install or a replace, and says which one it is.
 */
export async function installCheck(
  name: string,
  version: string,
  opts: { home?: string; overwrite?: boolean } = {},
): Promise<InstallCheck> {
  const home = opts.home ?? homedir();
  const target = agentsSkillDir(home, name);
  const real = await realpath(dirname(target))
    .then((d) => join(d, name))
    .catch(() => undefined);
  const withReal = real && real !== target ? { realTarget: real } : {};
  const existing = await lstatOrNull(target);
  if (!existing) return { action: 'install', target, ...withReal };
  const local = await readSkillTree(target).catch(() => null);
  if (local && treeHash(local.files) === version)
    return { action: 'unchanged', target, ...withReal };
  // A copy that can't be read is never replaced: nobody saw what it holds.
  if (!local) return { action: 'skip', target, ...withReal };
  return { action: opts.overwrite === true ? 'replace' : 'skip', target, ...withReal };
}

export async function installSkillFiles(
  name: string,
  files: readonly TarFile[],
  version: string,
  opts: { home?: string; overwrite?: boolean; linkDirs?: readonly string[] } = {},
): Promise<InstallOutcome> {
  const home = opts.home ?? homedir();
  const linkDirs = opts.linkDirs ?? linkDirsForAgents();
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`invalid skill name '${name}'`);
  }
  if (!/^[0-9a-f]{64}$/.test(version)) {
    throw new Error(`skill '${name}': no valid version named for these files`);
  }
  const sha = treeHash(files);
  if (sha !== version) {
    throw new Error(
      `skill '${name}': files hash to ${sha.slice(0, 12)}, the hub says ${version.slice(0, 12)}`,
    );
  }
  const overwrite = opts.overwrite === true;
  const target = agentsSkillDir(home, name);
  const existing = await lstatOrNull(target);
  if (existing) {
    const local = await readSkillTree(target).catch(() => null);
    if (local && treeHash(local.files) === sha) {
      return {
        name,
        status: 'unchanged',
        dir: target,
        ...(await linkAll(home, name, target, overwrite, linkDirs)),
      };
    }
    if (!local) {
      return {
        name,
        status: 'skipped',
        reason: `the local copy at ${target} can't be read, so it is not replaced`,
      };
    }
    if (!overwrite) {
      return { name, status: 'skipped', reason: `a different local copy exists at ${target}` };
    }
  }

  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const tag = randomBytes(4).toString('hex');
  const staging = join(parent, `.agentbox-dl-${name}-${tag}`);
  const old = join(parent, `.agentbox-old-${name}-${tag}`);
  let movedAside = false;
  try {
    for (const f of files) {
      const p = join(staging, ...f.path.split('/'));
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, f.data, { mode: f.mode });
    }
    if (existing) {
      await rename(target, old);
      movedAside = true;
    }
    await rename(staging, target);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    // Put the user's copy back if it was moved aside and the swap didn't finish.
    if (movedAside && !(await lstatOrNull(target)))
      await rename(old, target).catch(() => undefined);
    throw err;
  }
  if (movedAside) await rm(old, { recursive: true, force: true });
  return {
    name,
    status: existing ? 'replaced' : 'installed',
    dir: target,
    ...(await linkAll(home, name, target, overwrite, linkDirs)),
  };
}
