/**
 * Moving skills between this PC and the hub's library: compare, upload, the
 * automatic first seed, and download (docs/hub-skills-plan.md, Phase 1).
 *
 * Everything goes through the hub's `/api/v1/skills` (the CLI never touches
 * custody directly), so a local hub and a remote control box behave the same.
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { getMachineLabel, tryGetMachineId } from '@agentbox/config';
import type { HubApiClient, HubApiSkill } from '../../control-plane/hub-api-client.js';
import { discoverLocalSkills, type LocalSkill } from './discover.js';
import { readTar, writeTar } from './tar.js';
import { readSkillTree, treeHash } from './tree.js';

export interface SkillsContext {
  home: string;
  /** `skills.maxSkillBytes`. */
  maxBytes: number;
}

export type SkillRowStatus = 'same' | 'differs' | 'local-only' | 'hub-only';

export interface SkillRow {
  name: string;
  local?: LocalSkill;
  hub?: HubApiSkill;
  status: SkillRowStatus;
  /** For `differs`: which side changed last (local file mtime vs hub upload time). */
  newer?: 'local' | 'hub';
}

/** Local and hub skills side by side, matched by name. */
export function compareSkills(
  local: readonly LocalSkill[],
  hub: readonly HubApiSkill[],
): SkillRow[] {
  const rows = new Map<string, SkillRow>();
  for (const l of local) rows.set(l.name, { name: l.name, local: l, status: 'local-only' });
  for (const h of hub) {
    const row = rows.get(h.name);
    if (!row) {
      rows.set(h.name, { name: h.name, hub: h, status: 'hub-only' });
      continue;
    }
    row.hub = h;
    if (row.local!.treeSha === h.current) {
      row.status = 'same';
    } else {
      row.status = 'differs';
      row.newer = row.local!.newestMtimeMs > Date.parse(h.updatedAt) ? 'local' : 'hub';
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type UploadOutcome =
  | { name: string; status: 'uploaded' | 'unchanged'; version: string }
  | { name: string; status: 'skipped'; reason: string };

/** Why a local skill can't be uploaded without an override, or null. */
export function uploadBlocker(
  skill: LocalSkill,
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

export async function uploadLocalSkill(
  client: HubApiClient,
  skill: LocalSkill,
  opts: { allowFindings?: boolean } = {},
): Promise<UploadOutcome> {
  const blocker = uploadBlocker(skill, opts);
  if (blocker) return { name: skill.name, status: 'skipped', reason: blocker };
  const res = await client.uploadSkill(skill.name, writeTar(skill.files), {
    sha256: skill.treeSha,
    description: skill.description,
    size: skill.size,
    files: skill.files.length,
    source: {
      host: getMachineLabel(),
      ...(tryGetMachineId() ? { machineId: tryGetMachineId()! } : {}),
      path: skill.dir,
    },
  });
  return { name: skill.name, status: res.changed ? 'uploaded' : 'unchanged', version: res.version };
}

export interface SeedOutcome {
  uploaded: string[];
  skipped: { name: string; reason: string }[];
  /** Uploads that failed on the wire (the rest still went). */
  failed: { name: string; reason: string }[];
}

/**
 * The automatic first seed (owner direction 2): when the hub has never held a
 * skill, upload every clean local skill. Flagged or invalid skills are skipped
 * and named. Returns null when the hub is already seeded — after the first seed,
 * adding a skill is always an explicit action.
 */
export async function seedSkillsIfEmpty(
  client: HubApiClient,
  ctx: SkillsContext,
): Promise<SeedOutcome | null> {
  const listing = await client.listSkills();
  if (listing.seeded) return null;
  const local = await discoverLocalSkills({ home: ctx.home, maxBytes: ctx.maxBytes });
  const out: SeedOutcome = { uploaded: [], skipped: [], failed: [] };
  for (const skill of local) {
    try {
      const r = await uploadLocalSkill(client, skill);
      if (r.status === 'skipped') out.skipped.push({ name: r.name, reason: r.reason });
      else out.uploaded.push(r.name);
    } catch (err) {
      out.failed.push({
        name: skill.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** One line for a seed result, for the setup step and the create path. */
export function describeSeed(o: SeedOutcome): string {
  const parts = [
    `seeded the hub's skills library with ${String(o.uploaded.length)} skill(s) from this PC`,
  ];
  if (o.skipped.length > 0) {
    parts.push(
      `skipped ${String(o.skipped.length)} (${o.skipped.map((s) => s.name).join(', ')}) — review with \`agentbox skills\``,
    );
  }
  if (o.failed.length > 0)
    parts.push(`${String(o.failed.length)} failed (${o.failed.map((s) => s.name).join(', ')})`);
  return parts.join('; ');
}

export type DownloadOutcome =
  | {
      name: string;
      status: 'installed' | 'replaced' | 'unchanged';
      dir: string;
      claudeLink?: string;
    }
  | { name: string; status: 'skipped'; reason: string };

/** Where downloads land (plan decision 10). */
export function agentsSkillDir(home: string, name: string): string {
  return join(home, '.agents', 'skills', name);
}

async function lstatOrNull(p: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

/**
 * Point `~/.claude/skills/<name>` at the downloaded copy — claude is the one
 * measured agent that doesn't read `~/.agents/skills`. Only when claude is set up
 * here (`~/.claude` exists). A real directory there is replaced only with
 * `overwrite`, which the caller asked the user for.
 */
async function linkForClaude(
  home: string,
  name: string,
  target: string,
  overwrite: boolean,
): Promise<string | undefined> {
  // `stat`, not `lstat`: a dotfile manager often makes `~/.claude` itself a link.
  const claudeHome = await stat(join(home, '.claude')).catch(() => null);
  if (!claudeHome?.isDirectory()) return undefined;
  const link = join(home, '.claude', 'skills', name);
  const rel = join('..', '..', '.agents', 'skills', name);
  const st = await lstatOrNull(link);
  if (st?.isSymbolicLink()) {
    if (resolve(dirname(link), await readlink(link)) === target) return link;
    if (!overwrite) return undefined;
    await rm(link, { force: true });
  } else if (st) {
    const existing = await readSkillTree(link).catch(() => null);
    const sameAsTarget =
      existing !== null &&
      treeHash(existing.files) === treeHash((await readSkillTree(target)).files);
    // Already the same skill: claude reads it either way, so leave the user's layout be.
    if (sameAsTarget) return link;
    if (!overwrite) return undefined;
    await rm(link, { recursive: true, force: true });
  }
  await mkdir(dirname(link), { recursive: true });
  await symlink(rel, link);
  return link;
}

/**
 * Install a hub skill on this PC at `~/.agents/skills/<name>`. The tarball's
 * tree hash is re-derived and must match the version the hub named, so what
 * lands is exactly what was uploaded. An existing local skill with different
 * content is replaced only with `overwrite`.
 */
export async function downloadHubSkill(
  client: HubApiClient,
  name: string,
  ctx: SkillsContext,
  opts: { overwrite?: boolean; version?: string } = {},
): Promise<DownloadOutcome> {
  const got = await client.downloadSkill(name, opts.version);
  const files = readTar(got.data, { maxBytes: ctx.maxBytes });
  const sha = treeHash(files);
  if (got.version && sha !== got.version) {
    throw new Error(
      `skill '${name}': downloaded files hash to ${sha.slice(0, 12)}, hub says ${got.version.slice(0, 12)}`,
    );
  }
  const target = agentsSkillDir(ctx.home, name);
  const existing = await lstatOrNull(target);
  if (existing) {
    const local = await readSkillTree(target).catch(() => null);
    if (local && treeHash(local.files) === sha) {
      const claudeLink = await linkForClaude(ctx.home, name, target, opts.overwrite === true);
      return { name, status: 'unchanged', dir: target, ...(claudeLink ? { claudeLink } : {}) };
    }
    if (!opts.overwrite) {
      return { name, status: 'skipped', reason: `a different local copy exists at ${target}` };
    }
  }

  // Write next to the target under a dot-name (discovery skips those), then swap
  // it in, so a failed download never leaves a half-written skill.
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
  const claudeLink = await linkForClaude(ctx.home, name, target, opts.overwrite === true);
  return {
    name,
    status: existing ? 'replaced' : 'installed',
    dir: target,
    ...(claudeLink ? { claudeLink } : {}),
  };
}
