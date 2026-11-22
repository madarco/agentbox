// Skills: the hub's skills library, kept in the custody `skills` scope
// (docs/hub-skills-plan.md, owner direction 1 — built on custody, not a second
// store). Layout:
//
//   skills/<name>/meta.json          SkillMeta: description, current version, version list
//   skills/<name>/<treeSha>.tar.gz   one normalized tree per version
//   skills/.seeded                   written by the first import ever; never removed
//
// The version id is the TREE hash the uploading PC computed over the normalized
// files (sorted paths, modes, content hashes), not the tarball's bytes: the same
// skill from two PCs is the same version even though their tar streams differ.
// The downloading PC re-derives it from the extracted files before installing,
// so a hub can't hand back a tree that doesn't match the id it advertises.
//
// Pure over a structural slice of the custody store, so it runs against an
// in-memory fake in tests and against `globalThis.__AGENTBOX_HUB_CUSTODY` in the
// routes (which keeps @agentbox/relay out of Next's bundle).

import { createHash } from 'node:crypto';

export interface SkillsStoreEntry {
  path: string;
  size: number;
  sha256: string;
  updatedAt: string;
}

/** The custody verbs the library needs. `FsCustodyStore` satisfies it structurally. */
export interface SkillsStore {
  list(prefix?: string): Promise<SkillsStoreEntry[]>;
  get(path: string): Promise<{ entry: SkillsStoreEntry; data: Buffer } | null>;
  put(path: string, data: Buffer): Promise<SkillsStoreEntry & { changed: boolean }>;
  putStream(
    path: string,
    body: NodeJS.ReadableStream,
    opts?: { maxBytes?: number },
  ): Promise<SkillsStoreEntry & { changed: boolean }>;
  getStream(path: string): Promise<{ entry: SkillsStoreEntry; data: NodeJS.ReadableStream } | null>;
  delete(path: string): Promise<boolean>;
}

/** Where a version came from, as the uploading PC reported it. Display only. */
export interface SkillSource {
  /** The PC's hostname (or enrolled device label). */
  host?: string;
  /** The PC's machine id (`~/.agentbox/machine-id`). */
  machineId?: string;
  /** The folder it was read from, on that PC. */
  path?: string;
}

export interface SkillVersionMeta {
  /** Tree hash (hex sha256) — the version id. */
  sha256: string;
  /** sha256 of the stored tarball bytes. */
  tarballSha256: string;
  tarballBytes: number;
  /** Total bytes of the skill's files, unpacked. */
  size: number;
  files: number;
  uploadedAt: string;
  source: SkillSource;
}

export interface SkillMeta {
  schema: 1;
  name: string;
  description: string;
  /** Tree hash of the current version. */
  current: string;
  updatedAt: string;
  /** Newest first. */
  versions: SkillVersionMeta[];
}

/** One row of `GET /api/v1/skills`. */
export interface SkillSummary {
  name: string;
  description: string;
  current: string;
  size: number;
  files: number;
  tarballBytes: number;
  updatedAt: string;
  source: SkillSource;
  versions: number;
}

export interface SkillsListing {
  /** True once any skill was ever imported here, even if every one was since discarded. */
  seeded: boolean;
  skills: SkillSummary[];
}

/** What the uploading PC states about the tarball it streams. */
export interface SkillImportMeta {
  sha256: string;
  description: string;
  size: number;
  files: number;
  source?: SkillSource;
}

export const SKILLS_SCOPE = 'skills';
export const SEEDED_MARKER = `${SKILLS_SCOPE}/.seeded`;
/** Versions kept per skill; older tarballs are deleted on import. */
export const MAX_SKILL_VERSIONS = 5;

// The Agent Skills spec's name rule: lowercase letters, digits and hyphens, up
// to 64 characters. It is also a valid custody segment, so a name maps onto a
// path with no escaping.
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** AgentBox's own skills keep their baked/seeded path; the library never holds one. */
export const RESERVED_SKILL_PREFIX = 'agentbox-';

export class SkillsError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'SkillsError';
  }
}

export function skillNameProblem(name: string): string | null {
  if (!SKILL_NAME_RE.test(name)) {
    return `invalid skill name '${name}': lowercase letters, digits and hyphens, up to 64 characters`;
  }
  // `agentbox` itself is the `/agentbox` fork skill `agentbox install` puts on
  // every PC; `agentbox-*` are the in-box setup/identity skills.
  if (name === 'agentbox' || name.startsWith(RESERVED_SKILL_PREFIX)) {
    return `'${name}' is reserved for AgentBox's own skills`;
  }
  return null;
}

function assertName(name: string): void {
  const problem = skillNameProblem(name);
  if (problem) throw new SkillsError('invalid_request', problem);
}

const metaPath = (name: string): string => `${SKILLS_SCOPE}/${name}/meta.json`;
const tarballPath = (name: string, sha: string): string => `${SKILLS_SCOPE}/${name}/${sha}.tar.gz`;

/** Parse an import's metadata (the route decodes it from a header). Throws `invalid_request`. */
export function parseImportMeta(raw: unknown): SkillImportMeta {
  if (!raw || typeof raw !== 'object') {
    throw new SkillsError('invalid_request', 'skill metadata must be a JSON object');
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.sha256 !== 'string' || !SHA256_RE.test(m.sha256)) {
    throw new SkillsError('invalid_request', 'skill metadata needs a hex sha256 tree hash');
  }
  if (typeof m.description !== 'string' || m.description.length > 2048) {
    throw new SkillsError('invalid_request', 'skill metadata needs a description (max 2048 chars)');
  }
  const nonNeg = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (!nonNeg(m.size) || !nonNeg(m.files)) {
    throw new SkillsError('invalid_request', 'skill metadata needs integer size and files');
  }
  const source: SkillSource = {};
  if (m.source && typeof m.source === 'object') {
    const s = m.source as Record<string, unknown>;
    for (const k of ['host', 'machineId', 'path'] as const) {
      if (typeof s[k] === 'string' && (s[k] as string).length <= 512) source[k] = s[k] as string;
    }
  }
  return { sha256: m.sha256, description: m.description, size: m.size, files: m.files, source };
}

async function readMeta(store: SkillsStore, name: string): Promise<SkillMeta | null> {
  const found = await store.get(metaPath(name));
  if (!found) return null;
  try {
    const parsed = JSON.parse(found.data.toString('utf8')) as SkillMeta;
    return parsed && Array.isArray(parsed.versions) ? parsed : null;
  } catch {
    return null;
  }
}

function summarize(meta: SkillMeta): SkillSummary | null {
  const cur = meta.versions.find((v) => v.sha256 === meta.current) ?? meta.versions[0];
  if (!cur) return null;
  return {
    name: meta.name,
    description: meta.description,
    current: cur.sha256,
    size: cur.size,
    files: cur.files,
    tarballBytes: cur.tarballBytes,
    updatedAt: meta.updatedAt,
    source: cur.source,
    versions: meta.versions.length,
  };
}

export async function listSkills(store: SkillsStore): Promise<SkillsListing> {
  const entries = await store.list(SKILLS_SCOPE);
  const seeded = entries.some((e) => e.path === SEEDED_MARKER);
  const names = new Set<string>();
  for (const e of entries) {
    const m = /^skills\/([^/]+)\/meta\.json$/.exec(e.path);
    if (m) names.add(m[1]!);
  }
  const skills: SkillSummary[] = [];
  for (const name of [...names].sort()) {
    const meta = await readMeta(store, name);
    const row = meta ? summarize(meta) : null;
    if (row) skills.push(row);
  }
  return { seeded, skills };
}

export interface ImportResult {
  name: string;
  version: string;
  /** False when this exact version was already stored. */
  changed: boolean;
  skill: SkillSummary;
}

/**
 * Store one version of a skill from a streamed tarball, make it current, keep
 * the newest {@link MAX_SKILL_VERSIONS}, and mark the library seeded.
 */
export async function importSkill(
  store: SkillsStore,
  input: {
    name: string;
    meta: SkillImportMeta;
    body: NodeJS.ReadableStream;
    maxBytes?: number;
    now?: Date;
  },
): Promise<ImportResult> {
  assertName(input.name);
  const { name, meta } = input;
  const now = (input.now ?? new Date()).toISOString();
  const stored = await store.putStream(tarballPath(name, meta.sha256), input.body, {
    ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
  });

  const prev = await readMeta(store, name);
  const known = prev?.versions.find((v) => v.sha256 === meta.sha256);
  const version: SkillVersionMeta = {
    sha256: meta.sha256,
    tarballSha256: stored.sha256,
    tarballBytes: stored.size,
    size: meta.size,
    files: meta.files,
    // Re-uploading a version it already has keeps when it first arrived.
    uploadedAt: known && !stored.changed ? known.uploadedAt : now,
    source: meta.source ?? {},
  };
  const others = (prev?.versions ?? []).filter((v) => v.sha256 !== meta.sha256);
  const versions = [version, ...others];
  const dropped = versions.splice(MAX_SKILL_VERSIONS);
  for (const v of dropped) await store.delete(tarballPath(name, v.sha256));

  const next: SkillMeta = {
    schema: 1,
    name,
    description: meta.description,
    current: meta.sha256,
    updatedAt: prev?.current === meta.sha256 && !stored.changed ? prev.updatedAt : now,
    versions,
  };
  await store.put(metaPath(name), Buffer.from(JSON.stringify(next, null, 2), 'utf8'));

  if (!(await store.get(SEEDED_MARKER))) {
    await store.put(SEEDED_MARKER, Buffer.from(JSON.stringify({ at: now, first: name }), 'utf8'));
  }
  return {
    name,
    version: meta.sha256,
    changed: stored.changed || prev?.current !== meta.sha256,
    skill: summarize(next)!,
  };
}

/** Open a version's tarball (default: current). Throws `not_found`. */
export async function openSkillTarball(
  store: SkillsStore,
  name: string,
  version?: string,
): Promise<{ version: string; data: NodeJS.ReadableStream; bytes: number; tarballSha256: string }> {
  assertName(name);
  const meta = await readMeta(store, name);
  if (!meta) throw new SkillsError('not_found', `no skill '${name}' on this hub`);
  const sha = version ?? meta.current;
  if (!meta.versions.some((v) => v.sha256 === sha)) {
    throw new SkillsError('not_found', `skill '${name}' has no version ${sha.slice(0, 12)}`);
  }
  const found = await store.getStream(tarballPath(name, sha));
  if (!found)
    throw new SkillsError(
      'not_found',
      `skill '${name}' version ${sha.slice(0, 12)} is missing its tarball`,
    );
  return {
    version: sha,
    data: found.data,
    bytes: found.entry.size,
    tarballSha256: found.entry.sha256,
  };
}

/**
 * Delete a skill and every stored version. The `.seeded` marker stays, so an
 * emptied library is not re-seeded automatically.
 */
export async function discardSkill(store: SkillsStore, name: string): Promise<{ removed: number }> {
  assertName(name);
  // FsCustodyStore already matches the prefix by whole segments; the filter keeps
  // that guarantee for any other store behind the same seam, where `skills/foo`
  // listing `skills/foobar/…` would discard the wrong skill.
  const own = `${SKILLS_SCOPE}/${name}/`;
  const entries = (await store.list(`${SKILLS_SCOPE}/${name}`)).filter((e) =>
    e.path.startsWith(own),
  );
  if (entries.length === 0) throw new SkillsError('not_found', `no skill '${name}' on this hub`);
  let removed = 0;
  for (const e of entries) if (await store.delete(e.path)) removed++;
  return { removed };
}

/**
 * The library's skills digest: the same hash `@agentbox/sandbox-core`'s
 * `skillsDigest` computes on a PC (sorted `<name>:<treeSha>` lines, '' for none),
 * so a PC whose skills match the library produces the same value. A control box
 * compares it with a shared bake's `base.skillsDigest` before adopting it. Re-implemented
 * here because Next routes can't import sandbox-core (execa breaks the standalone
 * build); `test/skills-backend.test.ts` pins the two to the same output.
 */
export function libraryDigest(skills: readonly { name: string; current: string }[]): string {
  if (skills.length === 0) return '';
  const lines = skills
    .map((s) => `${s.name}:${s.current}\n`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash('sha256');
  for (const l of lines) h.update(l);
  return h.digest('hex');
}

/**
 * Whether a control box should decline a shared bake because the skills baked
 * into it differ from the library (docs/hub-skills-plan.md, Phase 1b). A record
 * from before skills were tracked (no digest), or a library never seeded, never
 * blocks: that is exactly how adoption behaved before this check existed.
 */
export async function libraryBlocksAdoption(
  store: SkillsStore,
  recordDigest: string | undefined,
): Promise<boolean> {
  if (recordDigest === undefined) return false;
  const listing = await listSkills(store);
  if (!listing.seeded) return false;
  return libraryDigest(listing.skills) !== recordDigest;
}
