// Git and marketplace sources for the skills library (docs/hub-skills-plan.md,
// Phase 5). The HUB fetches: it holds the git credentials, and a box can't clone
// through the git shim. A fetched skill goes through the same normalization,
// size cap and secret scan a PC upload does (`readLocalSkill` from
// sandbox-core), then through `importSkill`, which decides by the skill's
// update policy whether the new version becomes current or waits for approval.
//
// A marketplace is a git source with one more hop: the marketplace repo's
// `.claude-plugin/marketplace.json` names where each plugin lives (a path in the
// same repo, another GitHub repo, a URL, or a subdirectory of one), and only the
// plugin's skills are imported. Plugins as a whole keep riding the agent's
// config tree (plan decision 4).
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, normalize, posix, sep } from 'node:path';
import { Readable } from 'node:stream';
import {
  parseSkillFrontmatter,
  readLocalSkill,
  writeTar,
  type LocalSkill,
} from '@agentbox/sandbox-core';
import {
  importSkill,
  listSkillMetas,
  originOf,
  readSkillMeta,
  skillNameProblem,
  SkillsError,
  type ImportResult,
  type SkillOrigin,
  type SkillsStore,
  type SkillUpdatePolicy,
} from './skills';

/** Default per-skill cap on the hub (the PC enforces `skills.maxSkillBytes`). */
export const HUB_SKILL_MAX_BYTES = 50 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;

export interface GitSpec {
  url: string;
  ref?: string;
  /** Path inside the repo to a skill, or to a folder of skills. */
  path?: string;
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * `<url>[#path][@ref]`, also `owner/repo` for GitHub. Flags win over the
 * suffixes. A `@` counts as a ref only after the last `/` (so `git@host:o/r`
 * keeps its user) or inside the `#` fragment.
 */
export function parseGitSpec(
  input: string,
  flags: { ref?: string; path?: string } = {},
  opts: { allowFile?: boolean } = {},
): GitSpec {
  let rest = input.trim();
  let path: string | undefined;
  let ref: string | undefined;
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    const frag = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
    const at = frag.lastIndexOf('@');
    if (at >= 0) {
      ref = frag.slice(at + 1) || undefined;
      path = frag.slice(0, at) || undefined;
    } else {
      path = frag || undefined;
    }
  } else {
    const at = rest.lastIndexOf('@');
    // `git@host:repo.git` has no `/`; its `@` is the scp user, not a ref.
    const scpUser = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(rest) && at === rest.indexOf('@');
    if (at > rest.lastIndexOf('/') && at > 0 && !scpUser) {
      ref = rest.slice(at + 1) || undefined;
      rest = rest.slice(0, at);
    }
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(rest)) {
    rest = `https://github.com/${rest.replace(/\.git$/, '')}.git`;
  }
  const spec: GitSpec = { url: rest };
  const r = flags.ref ?? ref;
  const p = flags.path ?? path;
  if (r) spec.ref = r;
  if (p) spec.path = p.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  validateGitSpec(spec, opts);
  return spec;
}

/** Throws `invalid_request` on a URL, ref or path that could be misread by git or escape the repo. */
export function validateGitSpec(spec: GitSpec, opts: { allowFile?: boolean } = {}): void {
  const u = spec.url;
  const ok =
    /^https?:\/\/[^\s]+$/.test(u) ||
    /^ssh:\/\/[^\s]+$/.test(u) ||
    /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(u) ||
    (opts.allowFile === true && /^file:\/\/\/[^\s]+$/.test(u));
  if (!ok || u.startsWith('-')) {
    throw new SkillsError(
      'invalid_request',
      `unsupported git URL '${u}' (https://, ssh://, git@host:path${opts.allowFile ? ', file:///' : ''}, or owner/repo)`,
    );
  }
  if (spec.ref !== undefined && (!REF_RE.test(spec.ref) || spec.ref.includes('..'))) {
    throw new SkillsError('invalid_request', `invalid git ref '${spec.ref}'`);
  }
  if (spec.path !== undefined) {
    const n = posix.normalize(spec.path);
    if (n.startsWith('..') || n.startsWith('/') || n.split('/').includes('..')) {
      throw new SkillsError('invalid_request', `path '${spec.path}' leaves the repository`);
    }
  }
}

// ── git ─────────────────────────────────────────────────────────────────────

export interface GitRunner {
  (args: string[], opts?: { cwd?: string }): Promise<string>;
}

/** A non-interactive, time-boxed runner for `bin`; stdout back. */
export const gitRunner =
  (bin = 'git'): GitRunner =>
  (args, opts = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        {
          cwd: opts.cwd,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
        },
        (err, stdout, stderr) => {
          if (err) {
            const why = String(stderr || err.message)
              .trim()
              .split('\n')
              .slice(-3)
              .join(' ');
            reject(new SkillsError('invalid_request', `git ${args[0] ?? ''} failed: ${why}`));
          } else resolve(String(stdout));
        },
      );
    });

export const runGit: GitRunner = gitRunner();

export interface Checkout {
  dir: string;
  commit: string;
  cleanup(): Promise<void>;
}

/** A shallow checkout of one ref (branch, tag or full sha; default: the remote's HEAD). */
export async function fetchCheckout(git: GitRunner, url: string, ref?: string): Promise<Checkout> {
  const dir = await mkdtemp(join(tmpdir(), 'agentbox-skill-git-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    await git(['init', '-q'], { cwd: dir });
    await git(['remote', 'add', 'origin', url], { cwd: dir });
    await git(['fetch', '-q', '--depth', '1', 'origin', ref ?? 'HEAD'], { cwd: dir });
    await git(['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], { cwd: dir });
    const commit = (await git(['rev-parse', 'HEAD'], { cwd: dir })).trim();
    return { dir, commit, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** The commit a ref points at upstream, without fetching. Undefined when ls-remote can't say. */
export async function remoteCommit(
  git: GitRunner,
  url: string,
  ref?: string,
): Promise<string | undefined> {
  if (ref && FULL_SHA_RE.test(ref)) return ref;
  const out = await git(['ls-remote', url, ref ?? 'HEAD']);
  const lines = out
    .trim()
    .split('\n')
    .map((l) => l.split(/\s+/))
    .filter((p) => p.length >= 2 && FULL_SHA_RE.test(p[0]!));
  // An annotated tag lists the tag object, then the commit as `<ref>^{}`.
  const peeled = lines.find((p) => p[1]!.endsWith('^{}'));
  return (peeled ?? lines[0])?.[0];
}

// ── discovery inside a checkout ─────────────────────────────────────────────

export interface FoundSkill {
  name: string;
  dir: string;
  /** The skill's folder relative to the checkout root (POSIX). */
  relPath: string;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

function inside(realRoot: string, real: string): boolean {
  return real === realRoot || real.startsWith(realRoot + sep);
}

/**
 * `p` resolved through every symlink, or null when it is missing or resolves
 * outside the checkout. A third-party repo can commit `skills/foo ->
 * /root/.claude/skills/foo`; following it would import the hub owner's own files.
 */
async function realInside(realRoot: string, p: string): Promise<string | null> {
  const real = await realpath(p).catch(() => null);
  return real !== null && inside(realRoot, real) ? real : null;
}

async function underRoot(root: string, p: string): Promise<string> {
  const realRoot = await realpath(root);
  const real = await realpath(p).catch(() => {
    throw new SkillsError(
      'not_found',
      `no such path in the repository: ${p.slice(root.length + 1) || '.'}`,
    );
  });
  if (!inside(realRoot, real)) {
    throw new SkillsError('invalid_request', 'path leaves the repository');
  }
  return real;
}

function rel(root: string, dir: string): string {
  return dir === root
    ? ''
    : dir
        .slice(root.length + 1)
        .split(sep)
        .join('/');
}

async function skillAt(root: string, dir: string): Promise<FoundSkill | null> {
  // A SKILL.md linked out of its folder would leak the target's frontmatter.
  const md = await realInside(dir, join(dir, 'SKILL.md'));
  if (!md || !(await isFile(md))) return null;
  const fm = parseSkillFrontmatter(await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => ''));
  // A skill at a repo root has no meaningful folder name (the temp dir): its
  // frontmatter name is the name. Elsewhere the folder is, as the spec says.
  const name = dir === root ? (fm?.name ?? '') : basename(dir);
  return { name, dir, relPath: rel(root, dir) };
}

/**
 * Skills at `sub` in a checkout: `sub` itself when it holds a SKILL.md,
 * otherwise each `sub/skills/<name>/SKILL.md` and `sub/<name>/SKILL.md`.
 */
export async function discoverRepoSkills(root: string, sub = ''): Promise<FoundSkill[]> {
  const realRoot = await realpath(root);
  const base = await underRoot(realRoot, join(realRoot, normalize(sub || '.')));
  const self = await skillAt(realRoot, base);
  if (self) return [self];
  const found = new Map<string, FoundSkill>();
  for (const p of [join(base, 'skills'), base]) {
    // `skills` itself may be a link out of the checkout.
    const parent = await realInside(realRoot, p);
    if (!parent) continue;
    let names: string[];
    try {
      names = (await readdir(parent)).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      // Each folder is read at its resolved path, so its tree walk is bounded by
      // a folder inside the checkout; one that resolves outside is skipped.
      const dir = await realInside(realRoot, join(parent, n));
      if (!dir) continue;
      const s = await skillAt(realRoot, dir);
      // The name stays the folder's as committed, not its link target's.
      if (s && dir !== realRoot) s.name = n;
      if (s && !found.has(s.name)) found.set(s.name, s);
    }
  }
  return [...found.values()];
}

// ── marketplaces ────────────────────────────────────────────────────────────

export interface PluginLocation {
  /** The repo holding the plugin; `null` = the marketplace repo itself. */
  url: string | null;
  ref?: string;
  /** The plugin's root inside that repo. */
  path: string;
  /** Skill folders relative to the plugin root. */
  skillPaths: string[];
}

function cleanRel(p: string, what: string): string {
  const n = posix
    .normalize(p.replace(/\\/g, '/'))
    .replace(/^\.\/?/, '')
    .replace(/\/+$/, '');
  if (n === '.' || n === '') return '';
  if (n.startsWith('..') || n.startsWith('/') || n.split('/').includes('..')) {
    throw new SkillsError('invalid_request', `${what} '${p}' leaves the repository`);
  }
  return n;
}

/** Pure: where a plugin lives, from a parsed `.claude-plugin/marketplace.json`. */
export function resolvePluginLocation(manifest: unknown, plugin: string): PluginLocation {
  const m = (manifest ?? {}) as {
    plugins?: unknown;
    metadata?: { pluginRoot?: unknown };
  };
  const plugins = Array.isArray(m.plugins) ? (m.plugins as Record<string, unknown>[]) : [];
  const entry = plugins.find((p) => p && p.name === plugin);
  if (!entry) {
    const names = plugins
      .map((p) => p?.name)
      .filter((n): n is string => typeof n === 'string')
      .slice(0, 20);
    throw new SkillsError(
      'not_found',
      `no plugin '${plugin}' in this marketplace${names.length ? ` (has: ${names.join(', ')})` : ''}`,
    );
  }
  // Custom `skills` paths supplement the default `skills/` folder, as in Claude Code.
  const skillsField = entry.skills;
  const extra =
    typeof skillsField === 'string'
      ? [skillsField]
      : Array.isArray(skillsField)
        ? skillsField.filter((s): s is string => typeof s === 'string')
        : [];
  const skillPaths = [...new Set(['skills', ...extra].map((s) => cleanRel(s, 'skills path')))];
  const src = entry.source;
  if (typeof src === 'string') {
    const root = typeof m.metadata?.pluginRoot === 'string' ? m.metadata.pluginRoot : '';
    const joined =
      src.startsWith('./') || src.startsWith('../') || !root ? src : posix.join(root, src);
    return { url: null, path: cleanRel(joined, 'plugin source'), skillPaths };
  }
  if (src && typeof src === 'object') {
    const s = src as Record<string, unknown>;
    const ref = typeof s.sha === 'string' ? s.sha : typeof s.ref === 'string' ? s.ref : undefined;
    const withRef = ref ? { ref } : {};
    if (s.source === 'github' && typeof s.repo === 'string') {
      return {
        url: `https://github.com/${s.repo.replace(/\.git$/, '')}.git`,
        ...withRef,
        path: '',
        skillPaths,
      };
    }
    if ((s.source === 'url' || s.source === 'git') && typeof s.url === 'string') {
      return { url: s.url, ...withRef, path: '', skillPaths };
    }
    if (s.source === 'git-subdir' && typeof s.url === 'string') {
      const url = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.url)
        ? `https://github.com/${s.url}.git`
        : s.url;
      return {
        url,
        ...withRef,
        path: cleanRel(typeof s.path === 'string' ? s.path : '', 'plugin path'),
        skillPaths,
      };
    }
    throw new SkillsError(
      'invalid_request',
      `plugin '${plugin}' uses a '${String(s.source)}' source, which the skills library can't fetch`,
    );
  }
  throw new SkillsError('invalid_request', `plugin '${plugin}' has no source`);
}

/** The skills a plugin ships, found in its checkout. */
async function pluginSkills(root: string, loc: PluginLocation): Promise<FoundSkill[]> {
  const out = new Map<string, FoundSkill>();
  for (const sp of loc.skillPaths) {
    const sub = [loc.path, sp].filter(Boolean).join('/');
    let found: FoundSkill[];
    try {
      found = await discoverRepoSkills(root, sub);
    } catch (err) {
      if (err instanceof SkillsError && err.code === 'not_found') continue;
      throw err;
    }
    for (const f of found) if (!out.has(f.name)) out.set(f.name, f);
  }
  return [...out.values()];
}

// ── import ──────────────────────────────────────────────────────────────────

export interface SourceDeps {
  store: SkillsStore;
  git?: GitRunner;
  /** Tarball cap (custody's), passed to `importSkill`. */
  maxTarballBytes?: number;
  /** Per-skill content cap. Default {@link HUB_SKILL_MAX_BYTES}. */
  maxSkillBytes?: number;
  /** Allow `file:///` URLs (a loopback caller on a local hub). */
  allowFile?: boolean;
  now?: () => Date;
}

/** A found skill as the add flow reports it, importable or not. */
export interface SkillCandidate {
  name: string;
  description: string;
  path: string;
  size: number;
  files: number;
  problems: string[];
  findings: { rule: string; path: string; line: number }[];
}

export interface AddResult {
  commit: string;
  candidates: SkillCandidate[];
  imported: ImportResult[];
  /** Selected skills not imported, with the reason. */
  skipped: { name: string; reason: string }[];
}

function candidate(s: LocalSkill, relPath: string): SkillCandidate {
  return {
    name: s.name,
    description: s.description,
    path: relPath,
    size: s.size,
    files: s.files.length,
    problems: [...s.problems],
    findings: s.findings.map((f) => ({ rule: f.rule, path: f.path, line: f.line })),
  };
}

function blocker(c: SkillCandidate, allowFindings: boolean): string | null {
  const nameProblem = skillNameProblem(c.name);
  if (nameProblem) return nameProblem;
  if (c.problems.length > 0) return c.problems.join('; ');
  if (c.findings.length > 0 && !allowFindings) {
    const f = c.findings[0]!;
    return `secret scan: ${f.rule} in ${f.path}:${String(f.line)}${c.findings.length > 1 ? ` (+${String(c.findings.length - 1)} more)` : ''}`;
  }
  return null;
}

async function importLocal(
  deps: SourceDeps,
  skill: LocalSkill,
  origin: SkillOrigin,
  commit: string,
  opts: { policy?: SkillUpdatePolicy; apply?: boolean },
): Promise<ImportResult> {
  return importSkill(deps.store, {
    name: skill.name,
    meta: {
      sha256: skill.treeSha,
      description: skill.description,
      size: skill.size,
      files: skill.files.length,
      source: {
        host: 'hub',
        path: origin.kind === 'git' || origin.kind === 'marketplace' ? origin.url : '',
      },
    },
    body: Readable.from([writeTar(skill.files)]),
    origin,
    commit,
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.apply ? { apply: true } : {}),
    ...(deps.maxTarballBytes !== undefined ? { maxBytes: deps.maxTarballBytes } : {}),
    ...(deps.now ? { now: deps.now() } : {}),
  });
}

async function readFound(deps: SourceDeps, found: FoundSkill[]) {
  const max = deps.maxSkillBytes ?? HUB_SKILL_MAX_BYTES;
  return Promise.all(
    found.map(async (f) => {
      const skill = await readLocalSkill(f.name, f.dir, { maxBytes: max });
      return { found: f, skill, cand: candidate(skill, f.relPath) };
    }),
  );
}

async function addFound(
  deps: SourceDeps,
  found: FoundSkill[],
  originFor: (f: FoundSkill) => SkillOrigin,
  commit: string,
  opts: AddOpts,
): Promise<AddResult> {
  const read = await readFound(deps, found);
  const result: AddResult = {
    commit,
    candidates: read.map((r) => r.cand),
    imported: [],
    skipped: [],
  };
  if (opts.dryRun) return result;
  const want = opts.skills ? new Set(opts.skills) : null;
  if (want) {
    for (const n of want) {
      if (!read.some((r) => r.found.name === n))
        result.skipped.push({ name: n, reason: 'not found in the source' });
    }
  }
  for (const r of read) {
    if (want && !want.has(r.found.name)) continue;
    const why = blocker(r.cand, opts.allowFindings === true);
    if (why) {
      result.skipped.push({ name: r.found.name, reason: why });
      continue;
    }
    result.imported.push(
      await importLocal(deps, r.skill, originFor(r.found), commit, {
        ...(opts.policy ? { policy: opts.policy } : {}),
        apply: true,
      }),
    );
  }
  return result;
}

export interface AddOpts {
  /** Import only these (default: every skill found). */
  skills?: string[];
  policy?: SkillUpdatePolicy;
  allowFindings?: boolean;
  /** List what the source holds; import nothing. */
  dryRun?: boolean;
}

/** `POST /api/v1/skills {git}`: fetch a repo and import the skills at its path. */
export async function addFromGit(
  deps: SourceDeps,
  spec: GitSpec,
  opts: AddOpts = {},
): Promise<AddResult> {
  validateGitSpec(spec, { allowFile: deps.allowFile === true });
  const git = deps.git ?? runGit;
  const co = await fetchCheckout(git, spec.url, spec.ref);
  try {
    const found = await discoverRepoSkills(co.dir, spec.path ?? '');
    if (found.length === 0) {
      throw new SkillsError(
        'not_found',
        `no SKILL.md at ${spec.path || 'the repository root'}, its skills/ or its subfolders`,
      );
    }
    return await addFound(
      deps,
      found,
      (f) => ({
        kind: 'git',
        url: spec.url,
        ...(spec.ref ? { ref: spec.ref } : {}),
        ...(f.relPath ? { path: f.relPath } : {}),
        commit: co.commit,
      }),
      co.commit,
      opts,
    );
  } finally {
    await co.cleanup();
  }
}

export interface MarketplaceSpec {
  /** Display name (the key in known_marketplaces.json). */
  marketplace: string;
  /** The marketplace repo. */
  url: string;
  ref?: string;
  plugin: string;
}

async function readMarketplace(dir: string): Promise<unknown> {
  const missing = (): never => {
    throw new SkillsError('not_found', 'the repository has no .claude-plugin/marketplace.json');
  };
  const realRoot = await realpath(dir);
  const file = await realInside(realRoot, join(dir, '.claude-plugin', 'marketplace.json'));
  if (!file) missing();
  const raw = await readFile(file!, 'utf8').catch(missing);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new SkillsError('invalid_request', '.claude-plugin/marketplace.json is not valid JSON');
  }
}

/** Fetch a marketplace, resolve the plugin, and hand back a checkout holding it. */
async function checkoutPlugin(
  deps: SourceDeps,
  spec: MarketplaceSpec,
): Promise<{ co: Checkout; loc: PluginLocation; release(): Promise<void> }> {
  const git = deps.git ?? runGit;
  const market = await fetchCheckout(git, spec.url, spec.ref);
  try {
    const loc = resolvePluginLocation(await readMarketplace(market.dir), spec.plugin);
    if (loc.url === null) return { co: market, loc, release: market.cleanup };
    validateGitSpec(
      { url: loc.url, ...(loc.ref ? { ref: loc.ref } : {}) },
      { allowFile: deps.allowFile === true },
    );
    const plugin = await fetchCheckout(git, loc.url, loc.ref);
    await market.cleanup();
    return { co: plugin, loc, release: plugin.cleanup };
  } catch (err) {
    await market.cleanup();
    throw err;
  }
}

/** `POST /api/v1/skills {marketplace}`: import a marketplace plugin's skills. */
export async function addFromMarketplace(
  deps: SourceDeps,
  spec: MarketplaceSpec,
  opts: AddOpts = {},
): Promise<AddResult> {
  validateGitSpec(
    { url: spec.url, ...(spec.ref ? { ref: spec.ref } : {}) },
    { allowFile: deps.allowFile === true },
  );
  const { co, loc, release } = await checkoutPlugin(deps, spec);
  try {
    const found = await pluginSkills(co.dir, loc);
    if (found.length === 0) {
      throw new SkillsError('not_found', `plugin '${spec.plugin}' ships no skills`);
    }
    return await addFound(
      deps,
      found,
      () => ({
        kind: 'marketplace',
        marketplace: spec.marketplace,
        url: spec.url,
        ...(spec.ref ? { ref: spec.ref } : {}),
        plugin: spec.plugin,
        commit: co.commit,
      }),
      co.commit,
      opts,
    );
  } finally {
    await release();
  }
}

// ── refresh ─────────────────────────────────────────────────────────────────

export interface RefreshOutcome {
  name: string;
  status: 'up-to-date' | 'pending' | 'applied' | 'blocked' | 'failed' | 'not-refreshable';
  from?: string;
  to?: string;
  commit?: string;
  reason?: string;
}

/**
 * Re-fetch one git or marketplace skill. A new tree under `manual` lands as
 * pending (the skill is behind until approved); under `auto` it becomes current.
 */
export async function refreshSkill(
  deps: SourceDeps,
  name: string,
  opts: { allowFindings?: boolean } = {},
): Promise<RefreshOutcome> {
  const meta = await readSkillMeta(deps.store, name);
  if (!meta) throw new SkillsError('not_found', `no skill '${name}' on this hub`);
  const origin = originOf(meta);
  const git = deps.git ?? runGit;
  try {
    if (origin.kind === 'git') {
      const upstream = await remoteCommit(git, origin.url, origin.ref).catch(() => undefined);
      const known = meta.pending
        ? meta.versions.find((v) => v.sha256 === meta.pending)?.commit
        : origin.commit;
      if (upstream && (upstream === origin.commit || upstream === known)) {
        return { name, status: 'up-to-date', commit: upstream };
      }
      const co = await fetchCheckout(git, origin.url, origin.ref);
      try {
        const found = (await discoverRepoSkills(co.dir, origin.path ?? '')).find(
          (f) => f.name === name,
        );
        if (!found)
          return {
            name,
            status: 'failed',
            reason: `no longer at ${origin.path || 'the repository root'}`,
          };
        return await importRefreshed(
          deps,
          meta.current,
          found,
          { ...origin, commit: co.commit },
          co.commit,
          opts,
        );
      } finally {
        await co.cleanup();
      }
    }
    if (origin.kind === 'marketplace') {
      const { co, loc, release } = await checkoutPlugin(deps, origin);
      try {
        const found = (await pluginSkills(co.dir, loc)).find((f) => f.name === name);
        if (!found)
          return { name, status: 'failed', reason: `plugin '${origin.plugin}' no longer ships it` };
        return await importRefreshed(
          deps,
          meta.current,
          found,
          { ...origin, commit: co.commit },
          co.commit,
          opts,
        );
      } finally {
        await release();
      }
    }
    return {
      name,
      status: 'not-refreshable',
      reason: `a ${origin.kind} skill has no upstream to fetch`,
    };
  } catch (err) {
    return { name, status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

async function importRefreshed(
  deps: SourceDeps,
  current: string,
  found: FoundSkill,
  origin: SkillOrigin,
  commit: string,
  opts: { allowFindings?: boolean },
): Promise<RefreshOutcome> {
  const [r] = await readFound(deps, [found]);
  const why = blocker(r!.cand, opts.allowFindings === true);
  if (why) return { name: found.name, status: 'blocked', reason: why, commit };
  if (r!.skill.treeSha === current) {
    // Same files at a new commit: record the commit, nothing to approve.
    await importLocal(deps, r!.skill, origin, commit, {});
    return { name: found.name, status: 'up-to-date', commit };
  }
  const res = await importLocal(deps, r!.skill, origin, commit, {});
  return {
    name: found.name,
    status: res.held ? 'pending' : 'applied',
    from: current,
    to: res.version,
    commit,
  };
}

/** Refresh every git and marketplace skill. */
export async function refreshAllSkills(
  deps: SourceDeps,
  opts: { allowFindings?: boolean } = {},
): Promise<RefreshOutcome[]> {
  const metas = await listSkillMetas(deps.store);
  const out: RefreshOutcome[] = [];
  for (const m of metas) {
    const k = originOf(m).kind;
    if (k !== 'git' && k !== 'marketplace') continue;
    out.push(await refreshSkill(deps, m.name, opts));
  }
  return out;
}
