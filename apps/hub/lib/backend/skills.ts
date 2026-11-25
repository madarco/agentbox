// Skills: the hub's skills library, kept in the custody `skills` scope
// (docs/hub-skills-plan.md, owner direction 1 — built on custody, not a second
// store). Layout:
//
//   skills/<name>/meta.json          SkillMeta: description, current version, version list
//   skills/<name>/<treeSha>.tar.gz   one normalized tree per version
//   skills/.seeded                   written by the first import ever; never removed
//   skills/.skipped.json             names never synced (lib/backend/skill-skips.ts)
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
import { readSkips, skippedNames } from '@agentbox/core';

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
  /** The git commit it was read at (git and marketplace origins). */
  commit?: string;
  /** This version's SKILL.md description (absent on versions stored before Phase 5). */
  description?: string;
}

/**
 * Where a skill comes from (docs/hub-skills-plan.md, Phase 5). Decides the
 * default update policy and what a refresh re-fetches. Absent on a meta written
 * before Phase 5, which reads as `upload`.
 */
export type SkillOrigin =
  | { kind: 'upload' }
  | { kind: 'folder'; linked: true; path: string; host?: string; machineId?: string }
  | { kind: 'git'; url: string; ref?: string; path?: string; commit: string }
  | {
      kind: 'marketplace';
      marketplace: string;
      /** The marketplace repo's git URL. */
      url: string;
      ref?: string;
      plugin: string;
      commit: string;
    };

/**
 * `auto`: a new version becomes current at once and running boxes sync.
 * `manual`: a new version waits as `pending` until approved.
 */
export type SkillUpdatePolicy = 'auto' | 'manual';

/** Your own sources update on their own; third-party ones wait for approval. */
export function defaultPolicy(origin: SkillOrigin): SkillUpdatePolicy {
  return origin.kind === 'git' || origin.kind === 'marketplace' ? 'manual' : 'auto';
}

export interface SkillMeta {
  schema: 1;
  name: string;
  description: string;
  /** Tree hash of the current version: what boxes get. */
  current: string;
  updatedAt: string;
  /** Newest first. */
  versions: SkillVersionMeta[];
  origin?: SkillOrigin;
  /** Absent = {@link defaultPolicy} of the origin. */
  policy?: SkillUpdatePolicy;
  /** A fetched version waiting for approval (manual policy). Never equal to `current`. */
  pending?: string;
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
  origin: SkillOrigin;
  policy: SkillUpdatePolicy;
  /** A newer version waiting for approval: the skill is `behind`. */
  pending?: { version: string; uploadedAt: string; size: number; files: number; commit?: string };
}

export interface SkillsListing {
  /** True once any skill was ever imported here, even if every one was since discarded. */
  seeded: boolean;
  skills: SkillSummary[];
  /** Names the owner marked "never sync" (may include names the library doesn't hold). */
  skipped: string[];
}

/** What the uploading PC states about the tarball it streams. */
export interface SkillImportMeta {
  sha256: string;
  description: string;
  size: number;
  files: number;
  source?: SkillSource;
  /** Uploaded by a PC's linked-folder watch (`agentbox skills import --link`). */
  linked?: boolean;
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
    readonly code: 'invalid_request' | 'not_found' | 'conflict',
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
  if (m.linked === true && !source.path) {
    throw new SkillsError('invalid_request', 'a linked upload needs source.path');
  }
  return {
    sha256: m.sha256,
    description: m.description,
    size: m.size,
    files: m.files,
    source,
    ...(m.linked === true ? { linked: true } : {}),
  };
}

export function parsePolicy(raw: unknown): SkillUpdatePolicy {
  if (raw === 'auto' || raw === 'manual') return raw;
  throw new SkillsError('invalid_request', "policy must be 'auto' or 'manual'");
}

export function originOf(meta: SkillMeta): SkillOrigin {
  return meta.origin ?? { kind: 'upload' };
}

export function policyOf(meta: SkillMeta): SkillUpdatePolicy {
  return meta.policy ?? defaultPolicy(originOf(meta));
}

// Imports, refreshes, approvals and discards of one skill each read meta.json,
// change it and write it back; two at once (a linked-folder save racing a
// refresh) would drop a version entry. One hub process owns the library, so an
// in-process chain per name is enough.
const skillLocks = new Map<string, Promise<unknown>>();

export function withSkillLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = skillLocks.get(name) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  skillLocks.set(name, tail);
  void tail.then(() => {
    if (skillLocks.get(name) === tail) skillLocks.delete(name);
  });
  return run;
}

/** One skill's `meta.json`, or null when absent or unreadable. */
export async function readSkillMeta(store: SkillsStore, name: string): Promise<SkillMeta | null> {
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
    origin: originOf(meta),
    policy: policyOf(meta),
    ...pendingSummary(meta),
  };
}

function pendingSummary(meta: SkillMeta): Pick<SkillSummary, 'pending'> {
  const p = meta.pending ? meta.versions.find((v) => v.sha256 === meta.pending) : undefined;
  if (!p) return {};
  return {
    pending: {
      version: p.sha256,
      uploadedAt: p.uploadedAt,
      size: p.size,
      files: p.files,
      ...(p.commit ? { commit: p.commit } : {}),
    },
  };
}

async function writeMeta(store: SkillsStore, meta: SkillMeta): Promise<void> {
  await store.put(metaPath(meta.name), Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
}

/** Keep the newest {@link MAX_SKILL_VERSIONS}, never dropping current or pending. */
function retain(
  versions: SkillVersionMeta[],
  keep: readonly (string | undefined)[],
): { kept: SkillVersionMeta[]; dropped: SkillVersionMeta[] } {
  const kept: SkillVersionMeta[] = [];
  const dropped: SkillVersionMeta[] = [];
  for (const v of versions) {
    if (kept.length < MAX_SKILL_VERSIONS || keep.includes(v.sha256)) kept.push(v);
    else dropped.push(v);
  }
  return { kept, dropped };
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
    const meta = await readSkillMeta(store, name);
    const row = meta ? summarize(meta) : null;
    if (row) skills.push(row);
  }
  const skipped = skippedNames(await readSkips(store));
  return { seeded, skills, skipped };
}

export interface ImportResult {
  name: string;
  version: string;
  /** False when this exact version was already stored. */
  changed: boolean;
  /** True when the version waits for approval instead of becoming current. */
  held: boolean;
  /** True when `current` moved: running boxes that have the skill are now behind. */
  currentChanged: boolean;
  skill: SkillSummary;
}

/**
 * Store one version of a skill from a streamed tarball, and mark the library
 * seeded. Under the `auto` policy the version becomes current; under `manual`
 * (git and marketplace by default) a version that differs from current waits as
 * `pending` until {@link approveSkillUpdate}. The first version of a skill is
 * always current: adding a skill is itself the approval.
 */
export async function importSkill(
  store: SkillsStore,
  input: {
    name: string;
    meta: SkillImportMeta;
    body: NodeJS.ReadableStream;
    maxBytes?: number;
    now?: Date;
    /** Set by hub-side sources (git, marketplace). Default: from `meta.linked`. */
    origin?: SkillOrigin;
    /** An explicit policy (on add). Default: the skill's, else the origin's default. */
    policy?: SkillUpdatePolicy;
    /** Version provenance for git sources. */
    commit?: string;
    /** Make it current even under `manual` (an explicit add is its own approval). */
    apply?: boolean;
    /**
     * Refuse (`conflict`) unless the skill's current version is this one, checked
     * under the skill's lock; `null` = the skill must not exist yet. The web
     * editor's optimistic concurrency.
     */
    expectCurrent?: string | null;
  },
): Promise<ImportResult> {
  assertName(input.name);
  return withSkillLock(input.name, () => importLocked(store, input));
}

async function importLocked(
  store: SkillsStore,
  input: Parameters<typeof importSkill>[1],
): Promise<ImportResult> {
  const { name, meta } = input;
  const now = (input.now ?? new Date()).toISOString();
  if (input.expectCurrent !== undefined) {
    const cur = (await readSkillMeta(store, name))?.current ?? null;
    if (cur !== input.expectCurrent) {
      throw new SkillsError(
        'conflict',
        cur === null
          ? `skill '${name}' was discarded since the editor opened it`
          : input.expectCurrent === null
            ? `skill '${name}' already exists; open it to edit`
            : `skill '${name}' changed since the editor opened it (now ${cur.slice(0, 12)}); reload and edit again`,
      );
    }
  }
  const stored = await store.putStream(tarballPath(name, meta.sha256), input.body, {
    ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
  });

  const prev = await readSkillMeta(store, name);
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
    description: meta.description,
    ...(input.commit ? { commit: input.commit } : {}),
  };
  const origin: SkillOrigin =
    input.origin ??
    (meta.linked
      ? {
          kind: 'folder',
          linked: true,
          path: meta.source?.path ?? '',
          ...(meta.source?.host ? { host: meta.source.host } : {}),
          ...(meta.source?.machineId ? { machineId: meta.source.machineId } : {}),
        }
      : { kind: 'upload' });
  // A policy the user set survives re-imports from the same kind of source; a
  // different kind of source (a PC upload over a git skill) starts from its own
  // default, because the upload is the user's explicit act.
  const keptPolicy =
    input.policy ?? (prev?.policy && originOf(prev).kind === origin.kind ? prev.policy : undefined);
  const policy = keptPolicy ?? defaultPolicy(origin);

  const prevCurrentOk = Boolean(prev && prev.versions.some((v) => v.sha256 === prev.current));
  const held =
    policy === 'manual' &&
    input.apply !== true &&
    prev !== null &&
    prevCurrentOk &&
    prev.current !== meta.sha256;
  const current = held ? prev!.current : meta.sha256;
  const pending = held ? meta.sha256 : undefined;

  const others = (prev?.versions ?? []).filter((v) => v.sha256 !== meta.sha256);
  const { kept, dropped } = retain([version, ...others], [current, pending]);
  for (const v of dropped) await store.delete(tarballPath(name, v.sha256));

  const currentChanged = prev?.current !== current;
  const next: SkillMeta = {
    schema: 1,
    name,
    description: held ? prev!.description : meta.description,
    current,
    updatedAt: currentChanged || stored.changed ? now : prev!.updatedAt,
    versions: kept,
    origin,
    ...(keptPolicy ? { policy: keptPolicy } : {}),
    ...(pending ? { pending } : {}),
  };
  await writeMeta(store, next);

  if (!(await store.get(SEEDED_MARKER))) {
    await store.put(SEEDED_MARKER, Buffer.from(JSON.stringify({ at: now, first: name }), 'utf8'));
  }
  return {
    name,
    version: meta.sha256,
    changed: stored.changed || currentChanged || prev?.pending !== pending,
    held,
    currentChanged,
    skill: summarize(next)!,
  };
}

/**
 * Apply a skill's pending version (or `version`, any stored one): it becomes
 * current, and running boxes that have the skill are behind until they sync.
 */
export async function approveSkillUpdate(
  store: SkillsStore,
  name: string,
  version?: string,
  now: Date = new Date(),
  opts: { onlyPending?: boolean } = {},
): Promise<{ name: string; from: string; to: string; skill: SkillSummary }> {
  assertName(name);
  return withSkillLock(name, async () => {
    const meta = await readSkillMeta(store, name);
    if (!meta) throw new SkillsError('not_found', `no skill '${name}' on this hub`);
    const to = version ?? meta.pending;
    if (!to) throw new SkillsError('invalid_request', `skill '${name}' has no pending update`);
    if (opts.onlyPending && to !== meta.pending) {
      throw new SkillsError(
        'conflict',
        `skill '${name}': the pending update is ${meta.pending ? meta.pending.slice(0, 12) : 'gone'}, not the reviewed ${to.slice(0, 12)}; review it again`,
      );
    }
    if (!meta.versions.some((v) => v.sha256 === to)) {
      throw new SkillsError('not_found', `skill '${name}' has no version ${to.slice(0, 12)}`);
    }
    const from = meta.current;
    const desc = meta.versions.find((v) => v.sha256 === to)?.description;
    const next: SkillMeta = {
      ...meta,
      current: to,
      updatedAt: now.toISOString(),
      // A held import kept the old description; the approved version brings its own.
      ...(desc !== undefined ? { description: desc } : {}),
    };
    delete next.pending;
    if (meta.pending && meta.pending !== to) next.pending = meta.pending;
    await writeMeta(store, next);
    return { name, from, to, skill: summarize(next)! };
  });
}

export async function setSkillPolicy(
  store: SkillsStore,
  name: string,
  policy: SkillUpdatePolicy,
): Promise<SkillSummary> {
  assertName(name);
  return withSkillLock(name, async () => {
    const meta = await readSkillMeta(store, name);
    if (!meta) throw new SkillsError('not_found', `no skill '${name}' on this hub`);
    const next: SkillMeta = { ...meta, policy };
    await writeMeta(store, next);
    return summarize(next)!;
  });
}

/** A full version id from a full id or a unique prefix (min 7 hex) the CLI printed. */
export async function resolveSkillVersion(
  store: SkillsStore,
  name: string,
  ref: string,
): Promise<string> {
  const meta = await readSkillMeta(store, name);
  if (!meta) throw new SkillsError('not_found', `no skill '${name}' on this hub`);
  if (!/^[0-9a-f]{7,64}$/.test(ref)) {
    throw new SkillsError('invalid_request', `'${ref}' is not a version (7 to 64 hex characters)`);
  }
  const hits = meta.versions.filter((v) => v.sha256.startsWith(ref));
  if (hits.length === 1) return hits[0]!.sha256;
  throw new SkillsError(
    hits.length === 0 ? 'not_found' : 'invalid_request',
    hits.length === 0
      ? `skill '${name}' has no version ${ref}`
      : `version ${ref} is ambiguous for skill '${name}'`,
  );
}

/** Every skill's meta (for refresh and box status). */
export async function listSkillMetas(store: SkillsStore): Promise<SkillMeta[]> {
  const entries = await store.list(SKILLS_SCOPE);
  const out: SkillMeta[] = [];
  const names = new Set<string>();
  for (const e of entries) {
    const m = /^skills\/([^/]+)\/meta\.json$/.exec(e.path);
    if (m) names.add(m[1]!);
  }
  for (const name of [...names].sort()) {
    const meta = await readSkillMeta(store, name);
    if (meta) out.push(meta);
  }
  return out;
}

/** Open a version's tarball (default: current). Throws `not_found`. */
export async function openSkillTarball(
  store: SkillsStore,
  name: string,
  version?: string,
): Promise<{ version: string; data: NodeJS.ReadableStream; bytes: number; tarballSha256: string }> {
  assertName(name);
  const meta = await readSkillMeta(store, name);
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
  return withSkillLock(name, () => discardLocked(store, name));
}

async function discardLocked(store: SkillsStore, name: string): Promise<{ removed: number }> {
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
