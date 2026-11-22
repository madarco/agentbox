/**
 * Materialize this box's share of the hub's skills library
 * (docs/hub-skills-plan.md, Phase 2).
 *
 * Pulled over the relay, like `agents.list`: `skills.get` names the box's set
 * (its create-time selection, resolved by the host against the library's current
 * versions), `skills.blob` streams each tarball in bounded chunks (a cloud box's
 * answers ride a 1 MiB bridge cap). Each tarball is parsed by the same reader the
 * CLI uses — regular files only, no symlinks, no `..` — and its tree hash must
 * equal the version the host named before anything replaces the old copy.
 *
 * Layout:
 *   ~/.local/share/agentbox/skills/<name>/…   the canonical tree (vscode-owned,
 *                                             container layer / VM disk, never a
 *                                             shared docker volume)
 *   <inject dir>/<name> -> canonical          one link per agent `dir` injection
 *                                             (claude: /etc/claude-code/.claude/skills)
 *   ~/.local/share/agentbox/skills/.manifest.json   what ctl wrote
 *
 * ctl runs as `vscode`, so an injection dir under `/etc` is created once with
 * `sudo -n` and handed to vscode; without passwordless sudo that agent simply
 * gets no library skills (logged), the box still boots.
 *
 * Removal is manifest-based: only a skill or a link ctl wrote is ever deleted, so
 * the user's own in-box skills, AgentBox's `agentbox-*` ones and anything else in
 * an injection dir are never touched. Every failure is logged and contained.
 */
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readTar, treeHash } from '@agentbox/sandbox-core';
import { postRpcAwait } from './relay-rpc.js';

const execFileP = promisify(execFile);

export const SKILLS_LIBRARY_DIR = join(homedir(), '.local', 'share', 'agentbox', 'skills');
const MANIFEST_NAME = '.manifest.json';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
/** Upper bound on one skill's tarball/content; the hub's custody cap is 100 MiB. */
const MAX_SKILL_BYTES = 100 * 1024 * 1024;
/** Per-RPC bound: on a cloud box an unanswered RPC would otherwise never settle. */
const RPC_TIMEOUT_MS = 60_000;

interface RpcResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type SkillsRpc = (method: string, params: unknown) => Promise<RpcResult>;

interface Manifest {
  version: 1;
  /** name → installed tree hash. */
  skills: Record<string, string>;
  /** Absolute link paths ctl created. */
  links: string[];
}

export interface SkillsSyncResult {
  library: boolean;
  installed: string[];
  kept: string[];
  removed: string[];
  failed: { name: string; reason: string }[];
  linkDirsSkipped: string[];
}

async function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), RPC_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const defaultRpc: SkillsRpc = (method, params) => postRpcAwait(method, params);

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(root: string): Promise<Manifest> {
  try {
    const m = JSON.parse(await readFile(join(root, MANIFEST_NAME), 'utf8')) as Partial<Manifest>;
    return {
      version: 1,
      skills: m.skills && typeof m.skills === 'object' ? m.skills : {},
      links: Array.isArray(m.links) ? m.links.filter((l) => typeof l === 'string') : [],
    };
  } catch {
    return { version: 1, skills: {}, links: [] };
  }
}

async function download(rpc: SkillsRpc, name: string, version: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const res = await withTimeout(rpc('skills.blob', { name, version, offset }), 'skills.blob');
    if (res.exitCode !== 0)
      throw new Error(res.stderr.trim() || `skills.blob exit ${String(res.exitCode)}`);
    const body = JSON.parse(res.stdout) as { data?: unknown; size?: unknown; eof?: unknown };
    if (typeof body.data !== 'string') throw new Error('skills.blob returned no data');
    const chunk = Buffer.from(body.data, 'base64');
    parts.push(chunk);
    offset += chunk.length;
    if (offset > MAX_SKILL_BYTES) throw new Error('skill tarball exceeds the size bound');
    if (body.eof === true) break;
    if (chunk.length === 0) throw new Error('skills.blob made no progress');
  }
  return Buffer.concat(parts);
}

/** Write one skill's verified files into `root/<name>`, replacing any old copy atomically. */
async function install(root: string, name: string, version: string, gz: Buffer): Promise<void> {
  const files = readTar(gz, { maxBytes: MAX_SKILL_BYTES });
  const got = treeHash(files);
  if (got !== version) {
    throw new Error(`files hash to ${got.slice(0, 12)}, host named ${version.slice(0, 12)}`);
  }
  const target = join(root, name);
  const staging = join(root, `.dl-${name}`);
  const old = join(root, `.old-${name}`);
  await rm(staging, { recursive: true, force: true });
  for (const f of files) {
    const p = join(staging, ...f.path.split('/'));
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, f.data, { mode: f.mode });
  }
  await rm(old, { recursive: true, force: true });
  if (await exists(target)) await rename(target, old);
  await rename(staging, target);
  await rm(old, { recursive: true, force: true });
}

/** Make `dir` writable by this user, creating it with `sudo -n` when its parent is root-owned. */
async function ensureLinkDir(dir: string, log: (m: string) => void): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.agentbox-probe-${String(process.pid)}`);
    await writeFile(probe, '');
    await rm(probe, { force: true });
    return true;
  } catch {
    // Root-owned (e.g. /etc/claude-code): one sudo call hands it to us.
  }
  try {
    const { uid, gid } = userInfo();
    await execFileP(
      'sudo',
      ['-n', 'install', '-d', '-m', '0755', '-o', String(uid), '-g', String(gid), dir],
      {
        timeout: 10_000,
      },
    );
    return true;
  } catch (err) {
    log(
      `skills: cannot write ${dir} (no passwordless sudo?): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** Whether `link` is a symlink ctl made (pointing into the canonical tree). */
async function isOurLink(link: string, root: string): Promise<boolean> {
  try {
    if (!(await lstat(link)).isSymbolicLink()) return false;
    const to = resolve(dirname(link), await readlink(link));
    return to === root || to.startsWith(`${root}/`);
  } catch {
    return false;
  }
}

/**
 * One pass: fetch the set, install what changed, drop what left, relink. Never
 * throws; a box whose host has no library (or can't be reached) is left as it was.
 */
export async function syncBoxSkills(opts: {
  linkDirs: readonly string[];
  log: (msg: string) => void;
  rpc?: SkillsRpc;
  root?: string;
}): Promise<SkillsSyncResult> {
  const rpc = opts.rpc ?? defaultRpc;
  const root = opts.root ?? SKILLS_LIBRARY_DIR;
  const out: SkillsSyncResult = {
    library: false,
    installed: [],
    kept: [],
    removed: [],
    failed: [],
    linkDirsSkipped: [],
  };
  let set: { name: string; version: string }[];
  try {
    const res = await withTimeout(rpc('skills.get', {}), 'skills.get');
    if (res.exitCode !== 0) {
      opts.log(`skills: skills.get failed: ${res.stderr.trim() || `exit ${String(res.exitCode)}`}`);
      return out;
    }
    const body = JSON.parse(res.stdout) as { library?: unknown; skills?: unknown };
    if (body.library !== true) return out;
    const raw = Array.isArray(body.skills)
      ? (body.skills as { name?: unknown; version?: unknown }[])
      : [];
    set = raw.filter(
      (s): s is { name: string; version: string } =>
        typeof s.name === 'string' &&
        NAME_RE.test(s.name) &&
        typeof s.version === 'string' &&
        SHA_RE.test(s.version),
    );
  } catch (err) {
    opts.log(
      `skills: could not reach the host: ${err instanceof Error ? err.message : String(err)}`,
    );
    return out;
  }
  out.library = true;

  await mkdir(root, { recursive: true });
  const manifest = await readManifest(root);
  const want = new Map(set.map((s) => [s.name, s.version]));

  for (const s of set) {
    if (manifest.skills[s.name] === s.version && (await exists(join(root, s.name)))) {
      out.kept.push(s.name);
      continue;
    }
    try {
      await install(root, s.name, s.version, await download(rpc, s.name, s.version));
      manifest.skills[s.name] = s.version;
      out.installed.push(s.name);
    } catch (err) {
      out.failed.push({ name: s.name, reason: err instanceof Error ? err.message : String(err) });
      // A failed update keeps the copy it had; a failed first install leaves none.
    }
  }
  for (const name of Object.keys(manifest.skills)) {
    if (want.has(name)) continue;
    await rm(join(root, name), { recursive: true, force: true });
    delete manifest.skills[name];
    out.removed.push(name);
  }

  // Links: drop every one we made that no longer has a skill behind it, then
  // (re)make one per installed skill in each injection dir.
  const links = new Set<string>();
  for (const link of manifest.links) {
    const name = link.slice(link.lastIndexOf('/') + 1);
    const stillWanted =
      manifest.skills[name] !== undefined && opts.linkDirs.includes(dirname(link));
    if (stillWanted) {
      links.add(link);
      continue;
    }
    if (await isOurLink(link, root)) await rm(link, { force: true });
  }
  for (const dir of opts.linkDirs) {
    if (Object.keys(manifest.skills).length === 0) break;
    if (!(await ensureLinkDir(dir, opts.log))) {
      out.linkDirsSkipped.push(dir);
      continue;
    }
    for (const name of Object.keys(manifest.skills)) {
      const link = join(dir, name);
      const target = join(root, name);
      if (await exists(link)) {
        if (!(await isOurLink(link, root))) {
          // Something else owns the name (a user's in-box skill): leave it.
          opts.log(`skills: ${link} exists and is not ours; not linking ${name}`);
          continue;
        }
        if (resolve(dirname(link), await readlink(link)) === target) {
          links.add(link);
          continue;
        }
        await rm(link, { force: true });
      }
      await symlink(target, link);
      links.add(link);
    }
  }
  manifest.links = [...links].sort();
  await writeFile(join(root, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
  return out;
}

export function describeSkillsSync(r: SkillsSyncResult): string {
  if (!r.library) return 'skills: no library on the host; nothing changed';
  const parts = [
    `${String(r.installed.length)} installed`,
    `${String(r.kept.length)} unchanged`,
    `${String(r.removed.length)} removed`,
  ];
  if (r.failed.length > 0)
    parts.push(
      `${String(r.failed.length)} failed (${r.failed.map((f) => `${f.name}: ${f.reason}`).join('; ')})`,
    );
  if (r.linkDirsSkipped.length > 0) parts.push(`not linked into ${r.linkDirsSkipped.join(', ')}`);
  return `skills: ${parts.join(', ')}`;
}
