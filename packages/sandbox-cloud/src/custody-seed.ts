/**
 * A project's **seed material** in the control box's custody store: the files a
 * fresh clone of the repo does NOT contain, but a working box needs.
 *
 * The control box's create-worker clones the repo itself with a leased
 * GitHub-App token, so the repo needs no custody copy. What a clone can't give
 * it is the user's local, uncommitted state — untracked files and `.env`
 * /secrets — which on a PC-driven create is carried over from the working tree.
 * Without this, a box created from the web UI for a PC-added project comes up
 * missing exactly the files that make it runnable.
 *
 * Layout under `projects/<slug>/seed/`:
 *   untracked.tar.gz   — `git ls-files --others --exclude-standard`, tarred
 *   env.tar.gz         — the staged env/secret files, at their repo-relative paths
 *   manifest.json      — what was captured, from which commit, when
 *
 * Env files ride a tarball rather than one custody entry each because a custody
 * path is capped at 6 segments and its segments are `[A-Za-z0-9._-]`: a monorepo
 * `apps/web/.env.local` would need `projects/<slug>/seed/env/apps/web/.env.local`
 * (7), so per-file entries fail for exactly the layouts that need them most. A
 * tar also preserves nesting, modes, and odd filenames for free.
 *
 * Uploads are hash-skipped (sha256, never timestamps), so re-creating a box
 * from an unchanged tree sends zero bytes. Every push is best-effort: seed
 * material is a convenience for *later* hub creates, never a reason to fail the
 * create in front of the user.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { execa } from 'execa';
import { scanHostEnvFiles } from '@agentbox/sandbox-core';
import { hostReachable } from './reachability.js';

/** Bound on the seed upload once the control box is known to be up. */
export const SEED_PUSH_MS = 120_000;

/** One captured file, as recorded in the manifest. */
export interface SeedManifestFile {
  /** Custody path relative to `projects/<slug>/seed/`. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface SeedManifest {
  version: 1;
  /** Origin URL the seed was captured from — the join key back to a repo. */
  originUrl?: string;
  /** Branch checked out on the PC when captured. */
  baseBranch?: string;
  /** Commit the working tree sat on. Lets a consumer report seed staleness. */
  repoHeadSha?: string;
  files: SeedManifestFile[];
  createdAt: string;
}

/** One blob to store under `projects/<slug>/seed/`. */
export interface SeedItem {
  /** Path relative to the seed prefix, e.g. `untracked.tar.gz` or `env/.env`. */
  relPath: string;
  data: Buffer;
}

export interface BuildProjectSeedArgs {
  /** Absolute path of the project's git checkout. */
  projectRoot: string;
  /**
   * Env/secret file patterns to include, in `CreateBoxRequest.envFilesToImport`
   * form (basename globs like `.env`, `secrets.toml`). Resolved with the same
   * scan a create uses, so the seed captures exactly the files a PC-driven
   * create would have carried into the box.
   */
  envPatterns?: string[];
  /**
   * The control box's streaming-blob cap (`relay.custodyMaxBlobBytes`, default
   * 100 MiB). The untracked tar is dropped when it wouldn't fit (env + manifest
   * still go) — an oversized upload would fail the whole push, and a partial
   * seed beats none.
   *
   * This is the BLOB cap, not the JSON one: tars go over the streaming API now,
   * so they are bounded by what the store will accept rather than by what fits
   * in a base64 envelope. The old 0.7 fudge for base64 inflation does not apply.
   */
  maxBodyBytes?: number;
  /**
   * The approved `carry:` entries for this create. Packed into `carry.tar.gz` +
   * `carry.json` so a hub-built box gets the same files a locally-built one
   * would — including gitignored paths, which the untracked tar excludes by
   * design and which `carry:` exists to opt in.
   */
  carry?: CarrySeedSource[];
  log?: (line: string) => void;
}

export interface BuildProjectSeedResult {
  items: SeedItem[];
  manifest: SeedManifest;
  /** Set when the untracked tar was built but dropped for exceeding the cap. */
  skippedTarBytes?: number;
  /**
   * Repo-relative paths of the env/secret files captured. Callers surface these
   * so it is never a mystery which secrets were copied to the control box.
   */
  envFiles: string[];
}

/** Mirrors the relay's own default custody body cap (the JSON API). */
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Mirrors the relay's default streaming-blob cap; matches `box.cpMaxBytes`. */
export const DEFAULT_MAX_BLOB_BYTES = 100 * 1024 * 1024;

/** Above this, a seed item takes the streaming blob API. See `adminCustodySink`. */
const DEFAULT_BLOB_THRESHOLD_BYTES = 1024 * 1024;

/** Seed items carrying user-approved `carry:` material — never dropped silently. */
export const CARRY_SEED_ITEMS = ['carry.tar.gz', 'carry.json'];

/**
 * A failure to move user-approved `carry:` material.
 *
 * A distinct type rather than a message convention: every layer between here and
 * the create has a best-effort catch for seed material, and each one has to be
 * able to tell "the untracked tar didn't make it" (log and continue) from "the
 * files the user explicitly approved didn't make it" (stop). Matching on a
 * `carry:` string prefix worked until something threw that wasn't ours — a `tar`
 * failure, an fs error — and the box was then built without the approved files,
 * which is the bug this all exists to prevent.
 */
export class CarrySeedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CarrySeedError';
  }
}

/** True for a carry failure, across package/realm boundaries (name, not identity). */
export function isCarrySeedError(err: unknown): boolean {
  return err instanceof Error && err.name === 'CarrySeedError';
}

/**
 * Largest raw payload that still fits a `maxBodyBytes` **JSON** custody PUT. The
 * value is sent as base64 inside a JSON envelope, so it inflates by 4/3; the 0.7
 * factor is that plus headroom for the envelope itself.
 *
 * Only the JSON API needs this. The streaming blob API sends raw bytes, so its
 * cap is the cap.
 */
function maxJsonPayloadBytes(maxBodyBytes: number): number {
  return Math.floor(maxBodyBytes * 0.7);
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Capture a project's seed material from its working tree. Pure of custody /
 * network concerns so it can be unit-tested against a temp repo.
 */
export async function buildProjectSeed(
  args: BuildProjectSeedArgs,
): Promise<BuildProjectSeedResult> {
  const log = args.log ?? (() => {});
  const maxTarBytes = args.maxBodyBytes ?? DEFAULT_MAX_BLOB_BYTES;
  const items: SeedItem[] = [];
  let skippedTarBytes: number | undefined;

  const tar = await buildUntrackedTar(args.projectRoot);
  if (tar) {
    if (tar.length > maxTarBytes) {
      skippedTarBytes = tar.length;
      log(
        `seed: untracked tar is ${formatBytes(tar.length)} (> ${formatBytes(maxTarBytes)}) — skipping it; ` +
          'env files still pushed. Raise `relay.custodyMaxBlobBytes` to include it.',
      );
    } else {
      items.push({ relPath: 'untracked.tar.gz', data: tar });
    }
  }

  // Each file keeps its repo-relative path (not just its basename): `.env` and
  // `apps/web/.env` are different files, and the worker restores them where they
  // belong. The tar carries the nesting — see the header for why they can't be
  // per-file custody entries.
  const envRelPaths = args.envPatterns?.length
    ? await scanHostEnvFiles(args.projectRoot, args.envPatterns)
    : [];
  const envTar = await buildTarOf(args.projectRoot, envRelPaths);
  if (envTar) items.push({ relPath: 'env.tar.gz', data: envTar });

  // Approved `carry:` entries. Unlike the untracked tar, an over-cap carry is
  // NOT silently dropped: the user was shown these paths and said yes, so a
  // payload we can't ship has to fail the create rather than produce a box that
  // is quietly missing the file they asked for.
  const carry = args.carry?.length ? await buildCarrySeed(args.carry) : null;
  if (carry) {
    if (carry.tar.length > maxTarBytes) {
      throw new CarrySeedError(
        `carry: the approved entries pack to ${formatBytes(carry.tar.length)}, over this control box's ` +
          `${formatBytes(maxTarBytes)} custody blob cap. Raise \`relay.custodyMaxBlobBytes\` here and ` +
          'AGENTBOX_CUSTODY_MAX_BLOB_BYTES on the control box, or drop the entry from `carry:`.',
      );
    }
    items.push({ relPath: 'carry.tar.gz', data: carry.tar });
    items.push({
      relPath: 'carry.json',
      data: Buffer.from(JSON.stringify(carry.manifest), 'utf8'),
    });
  }

  const manifest: SeedManifest = {
    ...(await readSeedRepoMeta(args.projectRoot)),
    files: items.map((i) => ({ path: i.relPath, sha256: sha256Hex(i.data), bytes: i.data.length })),
  };
  return { items, manifest, skippedTarBytes, envFiles: envRelPaths };
}

/**
 * The manifest's repo metadata (origin, branch, HEAD) with an empty file list —
 * everything about a seed that costs only a few `git` reads, no tarring.
 */
async function readSeedRepoMeta(projectRoot: string): Promise<SeedManifest> {
  return {
    version: 1,
    originUrl: (await gitOut(projectRoot, ['remote', 'get-url', 'origin'])) ?? undefined,
    baseBranch: (await gitOut(projectRoot, ['branch', '--show-current'])) ?? undefined,
    repoHeadSha: (await gitOut(projectRoot, ['rev-parse', 'HEAD'])) ?? undefined,
    files: [],
    createdAt: new Date().toISOString(),
  };
}

/** Run a git command in `dir`, returning trimmed stdout or null. */
async function gitOut(dir: string, argv: string[]): Promise<string | null> {
  const r = await execa('git', ['-C', dir, ...argv], { reject: false });
  const out = (r.stdout ?? '').trim();
  return r.exitCode === 0 && out.length > 0 ? out : null;
}

/**
 * Tar the repo's untracked-not-ignored files, or null when there are none.
 * Mirrors the create-time carry-over (`git stash create` doesn't capture
 * untracked, so this is the same side channel), including the NUL-delimited
 * file list so odd filenames survive and COPYFILE_DISABLE to suppress macOS
 * AppleDouble sidecars.
 *
 * Compresses via zlib rather than `tar -z` so the bytes are **deterministic**:
 * gzip stamps the current time into its header, which would give an unchanged
 * tree a new sha256 on every run and defeat the hash-skip on the largest item
 * in the seed. zlib writes MTIME=0, so identical content hashes identically.
 */
async function buildUntrackedTar(repo: string): Promise<Buffer | null> {
  const list = await execa(
    'git',
    ['-C', repo, 'ls-files', '--others', '--exclude-standard', '-z'],
    {
      reject: false,
    },
  );
  if (list.exitCode !== 0 || list.stdout.length === 0) return null;
  return tarNulList(repo, list.stdout);
}

/** Tar `relPaths` (repo-relative) out of `repo`, or null when the list is empty. */
async function buildTarOf(repo: string, relPaths: string[]): Promise<Buffer | null> {
  if (relPaths.length === 0) return null;
  return tarNulList(repo, relPaths.join('\0') + '\0');
}

/**
 * What a carried entry needs to be reconstructed on the control box. A subset of
 * `ResolvedCarryEntry` minus `absSrc` (a path on the PC, meaningless there) and
 * `bytes`; the worker fills `absSrc` in from the extracted staging dir.
 */
export interface CarrySeedEntry {
  /** Index into the tar's top-level dirs — `<index>/<basename>` holds the payload. */
  index: number;
  rawSrc: string;
  rawDest: string;
  absDest: string;
  kind: 'file' | 'dir';
  basename: string;
  mode?: number;
  user?: number;
  optional: boolean;
  exclude?: string[];
  replaceEnvs?: boolean;
  replace?: unknown[];
  symlinkInfo?: 'safe' | 'outside-home';
}

/** The `carry.json` sidecar. */
export interface CarrySeedManifest {
  version: 1;
  entries: CarrySeedEntry[];
}

/**
 * Pack the approved `carry:` entries so a control box can apply them.
 *
 * The seed's untracked tar deliberately uses `git ls-files --others
 * --exclude-standard`, i.e. untracked-but-NOT-ignored. `carry:` is the mechanism
 * for opting an *ignored* path in (a DB dump under an ignored `backups/`, say),
 * so it needs its own transport — filtering it into the untracked tar would
 * quietly change what "untracked" means for every project.
 *
 * Payloads ride RAW, not rendered. `renderCarryEntries` substitutes
 * `{{AGENTBOX_*}}` placeholders from a box context (name, id) that does not
 * exist until the hub mints the box, so rendering here would bake in the wrong
 * values. The provider still renders at apply time, exactly as for a local create.
 *
 * Returns null when there is nothing to carry. Throws when an entry cannot be
 * packed — a carry the user explicitly approved must never be dropped quietly.
 */
export async function buildCarrySeed(
  entries: CarrySeedSource[],
): Promise<{ tar: Buffer; manifest: CarrySeedManifest } | null> {
  // `missing` entries are the resolver's record of an optional path that wasn't
  // there; nothing to pack, and the box is meant to come up without them.
  const present = entries.filter(
    (e): e is CarrySeedSource & { kind: 'file' | 'dir' } => e.kind === 'file' || e.kind === 'dir',
  );
  if (present.length === 0) return null;

  const stage = await mkdtemp(join(tmpdir(), 'agentbox-carry-seed-'));
  try {
    const manifest: CarrySeedManifest = { version: 1, entries: [] };
    const relPaths: string[] = [];
    for (const [index, entry] of present.entries()) {
      const name = basename(entry.absSrc) || `entry-${String(index)}`;
      const destDir = join(stage, String(index));
      await mkdir(destDir, { recursive: true });
      // Stage through tar rather than `cp -R`, so a directory entry's `exclude`
      // patterns are honoured exactly as the local carry path honours them
      // (`sync/carry.ts` builds the same `--exclude=` args). A plain copy would
      // sweep in `node_modules` and friends — inflating the upload past the
      // custody cap and failing a create that succeeds locally, for a payload
      // the box was never meant to receive.
      await stageCarryPayload(entry, join(destDir, name));
      relPaths.push(`${String(index)}/${name}`);
      manifest.entries.push({
        index,
        rawSrc: entry.rawSrc,
        rawDest: entry.rawDest,
        absDest: entry.absDest,
        kind: entry.kind,
        basename: name,
        ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
        ...(entry.user !== undefined ? { user: entry.user } : {}),
        optional: entry.optional,
        ...(entry.exclude ? { exclude: entry.exclude } : {}),
        ...(entry.replaceEnvs !== undefined ? { replaceEnvs: entry.replaceEnvs } : {}),
        ...(entry.replace ? { replace: entry.replace } : {}),
        ...(entry.symlinkInfo ? { symlinkInfo: entry.symlinkInfo } : {}),
      });
    }
    const tar = await tarNulList(stage, relPaths.join('\0') + '\0');
    if (!tar) {
      throw new CarrySeedError(
        `carry: could not pack ${String(present.length)} approved entry/entries for upload`,
      );
    }
    return { tar, manifest };
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Copy one carry source to `dest`, applying the entry's `exclude` patterns for a
 * directory. Tar both ways rather than `cp`: tar is what applies the excludes,
 * and it is the same tool (and the same flags) the local carry path uses, so a
 * hub-built box and a locally-built one receive byte-identical trees.
 */
async function stageCarryPayload(entry: CarrySeedSource, dest: string): Promise<void> {
  if (entry.kind === 'file') {
    const r = await execa('cp', ['-p', entry.absSrc, dest], { reject: false });
    if (r.exitCode !== 0) {
      throw new CarrySeedError(
        `carry: could not stage ${entry.rawSrc} for upload: ${(r.stderr || r.stdout || '').trim()}`,
      );
    }
    return;
  }
  await mkdir(dest, { recursive: true });
  const excludeArgs = (entry.exclude ?? []).map((p) => `--exclude=${p}`);
  // COPYFILE_DISABLE silences macOS BSD tar's `._*` resource-fork stubs, which
  // would otherwise land beside every carried file inside the box.
  const packed = await execa('tar', ['-C', entry.absSrc, ...excludeArgs, '-cf', '-', '.'], {
    encoding: 'buffer',
    reject: false,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (packed.exitCode !== 0 || !packed.stdout) {
    throw new CarrySeedError(
      `carry: could not stage ${entry.rawSrc} for upload: ${String(packed.stderr ?? '').trim()}`,
    );
  }
  const unpacked = await execa('tar', ['-C', dest, '-xf', '-'], {
    input: packed.stdout,
    reject: false,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (unpacked.exitCode !== 0) {
    throw new CarrySeedError(
      `carry: could not stage ${entry.rawSrc} for upload: ${String(unpacked.stderr ?? '').trim()}`,
    );
  }
}

/** The `ResolvedCarryEntry` fields {@link buildCarrySeed} reads. */
export interface CarrySeedSource {
  rawSrc: string;
  rawDest: string;
  absSrc: string;
  absDest: string;
  kind: 'file' | 'dir' | 'missing';
  mode?: number;
  user?: number;
  optional: boolean;
  exclude?: string[];
  replaceEnvs?: boolean;
  replace?: unknown[];
  symlinkInfo?: 'safe' | 'outside-home';
}

/**
 * Tar a NUL-delimited file list out of `dir`. NUL-delimited so spaces / quotes /
 * newlines in filenames survive, and COPYFILE_DISABLE to suppress macOS
 * AppleDouble sidecars.
 */
async function tarNulList(dir: string, nulList: string): Promise<Buffer | null> {
  const tar = await execa('tar', ['-C', dir, '--null', '-T', '-', '-cf', '-'], {
    input: nulList,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    encoding: 'buffer',
    reject: false,
    // Normally small (ignored dirs are excluded), but don't let a pathological
    // tree blow up the host process.
    maxBuffer: 256 * 1024 * 1024,
  });
  if (tar.exitCode !== 0) return null;
  const raw = tar.stdout;
  if (!raw || raw.length === 0) return null;
  return gzipSync(raw);
}

/**
 * The custody transport the seed push writes through — the seam that lets the SAME
 * seed logic run over two wires: the CLI `hub project push` injects a `/api/v1`
 * sink (the client surface, this step's move), while the create path keeps its
 * `/admin` sink (the internal registration flow, which holds the admin token). Both
 * write the identical `projects/<slug>/seed/*` blobs; only the wire differs.
 */
export interface SeedCustodySink {
  /** Manifest (paths + hashes) for the hash-skip pass, scoped to `prefix`. */
  list(prefix: string): Promise<{ path: string; sha256: string }[]>;
  /** Store bytes at a custody path. Throws when the host refuses (e.g. size cap). */
  put(path: string, data: Buffer): Promise<void>;
}

export interface PushProjectSeedArgs extends BuildProjectSeedArgs {
  /** Where the seed blobs are written (see {@link SeedCustodySink}). */
  sink: SeedCustodySink;
  /**
   * Base URL of the host, for the pre-build reachability probe only. The push is
   * best-effort and runs inside create, so a down host must not stall it on
   * undici's ~10s connect timeout — probe first, and skip the whole build if down.
   */
  probeUrl: string;
  /**
   * The reachability probe itself. Defaults to `hostReachable(probeUrl)`; injected
   * by tests (which drive the sink directly and have no real host to probe).
   */
  probe?: () => Promise<boolean>;
  /** Custody `projects/<slug>` key. */
  slug: string;
  /** Upload every item even when custody already holds identical bytes. */
  force?: boolean;
}

/**
 * A {@link SeedCustodySink} over the relay's internal `/admin/custody` wire. Used
 * by the create/registration flow (`cloud-provider.ts`), which authenticates with
 * the admin token it already holds. The CLI's client commands use a `/api/v1` sink
 * built from `CustodyClient` instead.
 */
export function adminCustodySink(opts: {
  controlPlaneUrl: string;
  adminToken: string;
  fetchImpl?: typeof fetch;
  /**
   * Payloads at or above this go to the streaming blob API instead of the
   * base64 JSON one. Well under the JSON cap on purpose: base64 costs 4/3 on
   * the wire and several times the payload in peak memory on a 4 GB control
   * box, so there is no reason to send anything sizeable that way.
   */
  blobThresholdBytes?: number;
}): SeedCustodySink {
  const base = opts.controlPlaneUrl.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const threshold = opts.blobThresholdBytes ?? DEFAULT_BLOB_THRESHOLD_BYTES;
  const auth = { Authorization: `Bearer ${opts.adminToken}` };
  const jsonHeaders = { 'Content-Type': 'application/json', ...auth };

  async function putJson(path: string, data: Buffer): Promise<Response> {
    return fetchImpl(`${base}/admin/custody/${encodeCustodyPath(path)}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ data: data.toString('base64') }),
    });
  }

  return {
    async list(prefix) {
      const res = await fetchImpl(`${base}/admin/custody?prefix=${encodeURIComponent(prefix)}`, {
        headers: jsonHeaders,
      });
      if (!res.ok) return [];
      return ((await res.json()) as { entries: { path: string; sha256: string }[] }).entries;
    },
    async put(path, data) {
      if (data.length < threshold) {
        const res = await putJson(path, data);
        if (!res.ok) throw new Error(`custody put ${path} → ${String(res.status)}`);
        return;
      }
      const res = await fetchImpl(`${base}/admin/custody-blob/${encodeCustodyPath(path)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', ...auth },
        body: new Uint8Array(data),
      });
      if (res.ok) return;
      // A hub predating the blob surface 404s the whole prefix. Fall back only
      // when the payload would actually fit the JSON API — otherwise say so,
      // because the alternative is dropping a file the user approved.
      if (res.status === 404) {
        if (data.length <= maxJsonPayloadBytes(DEFAULT_MAX_BODY_BYTES)) {
          const legacy = await putJson(path, data);
          if (!legacy.ok) throw new Error(`custody put ${path} → ${String(legacy.status)}`);
          return;
        }
        throw new Error(
          `custody put ${path}: this control box has no streaming blob API and ${formatBytes(data.length)} ` +
            'is too large for the JSON one — run `agentbox hub update` to update it',
        );
      }
      const detail = await res
        .text()
        .then((t) => t.slice(0, 300))
        .catch(() => '');
      throw new Error(`custody put ${path} → ${String(res.status)}${detail ? `: ${detail}` : ''}`);
    },
  };
}

export interface PushProjectSeedResult {
  uploaded: number;
  skipped: number;
  manifest: SeedManifest;
  skippedTarBytes?: number;
  /** Repo-relative paths of the env/secret files captured (see BuildProjectSeedResult). */
  envFiles: string[];
  /**
   * Seed blobs the control box refused (e.g. its own body cap is lower than
   * this machine's). They are excluded from the stored manifest; the rest of the
   * seed is still pushed.
   */
  dropped: string[];
  /**
   * True when the control box could not be reached, so NOTHING was pushed.
   * Distinct from `uploaded: 0` with everything hash-skipped, which is a
   * successful no-op — callers must not report the two the same way.
   */
  unreachable?: boolean;
}

/**
 * Build and upload a project's seed material, skipping blobs custody already
 * holds. The manifest is always written last, so a consumer never sees a
 * manifest describing files that aren't there yet.
 */
export async function pushProjectSeedToCustody(
  args: PushProjectSeedArgs,
): Promise<PushProjectSeedResult> {
  const log = args.log ?? (() => {});
  // Probe before building anything: the push is best-effort and runs inside
  // create, so a down host must not stall it on undici's ~10s connect timeout
  // (see reachability.ts).
  const reachable = args.probe ?? (() => hostReachable(args.probeUrl));
  if (!(await reachable())) {
    log('seed: control box unreachable — skipping the seed push');
    // Report the repo metadata only. Calling buildProjectSeed here would tar the
    // whole untracked tree to produce a manifest nothing will ever upload —
    // defeating the point of probing before we build anything.
    const manifest = await readSeedRepoMeta(args.projectRoot);
    // `unreachable` — not just zero counts. A caller that treats "0 uploaded"
    // as success would tell the user their project is registered when nothing
    // ever left the machine.
    return { uploaded: 0, skipped: 0, manifest, envFiles: [], dropped: [], unreachable: true };
  }
  const built = await buildProjectSeed(args);
  const prefix = `projects/${args.slug}/seed`;

  // Hash-skip against what's already stored, so an unchanged tree uploads nothing.
  const existing = new Map<string, string>();
  if (!args.force) {
    try {
      for (const e of await args.sink.list(prefix)) existing.set(e.path, e.sha256);
    } catch {
      // No manifest → treat everything as new. Re-uploading is harmless.
    }
  }

  let uploaded = 0;
  let skipped = 0;
  const put = async (relPath: string, data: Buffer): Promise<void> => {
    const path = `${prefix}/${relPath}`;
    if (!args.force && existing.get(path) === sha256Hex(data)) {
      skipped += 1;
      return;
    }
    await args.sink.put(path, data);
    uploaded += 1;
  };

  // A blob the control box won't take must not sink the whole push. The local
  // size gate can't be authoritative: the PC's `relay.custodyMaxBodyBytes` is
  // its own setting, while the CONTROL BOX enforces its own cap — so a tar this
  // side considers fine can still be refused there (and an oversized body is
  // dropped at the socket, so it surfaces as a network error, not a 413).
  // Degrade exactly like the local gate does: drop the blob, keep the rest.
  const dropped: string[] = [];
  for (const item of built.items) {
    try {
      await put(item.relPath, item.data);
    } catch (err) {
      // ...with ONE exception: the carry blobs. Untracked/env material is a
      // best-effort convenience, but `carry:` paths were shown to the user and
      // explicitly approved. Degrading those to a log line is how an approved
      // 25.7 MiB dump silently failed to reach a box in the first place.
      if (CARRY_SEED_ITEMS.includes(item.relPath)) {
        throw new CarrySeedError(
          `carry: the control box refused ${item.relPath} (${formatBytes(item.data.length)}): ` +
            `${err instanceof Error ? err.message : String(err)}. These files were approved for ` +
            'this box, so the create is stopping rather than building one without them.',
        );
      }
      dropped.push(item.relPath);
      log(
        `seed: the control box refused ${item.relPath} (${formatBytes(item.data.length)}): ` +
          `${err instanceof Error ? err.message : String(err)} — continuing without it. ` +
          'If it is a size limit, raise AGENTBOX_CUSTODY_MAX_BLOB_BYTES on the control box.',
      );
    }
  }
  // The manifest describes what is actually stored, so a dropped blob must not
  // appear in it — a consumer would otherwise look for a file that isn't there.
  const manifest: SeedManifest = {
    ...built.manifest,
    files: built.manifest.files.filter((f) => !dropped.includes(f.path)),
  };
  await put('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  log(`seed: ${String(uploaded)} uploaded, ${String(skipped)} unchanged → custody ${prefix}`);
  return {
    uploaded,
    skipped,
    manifest,
    skippedTarBytes: built.skippedTarBytes,
    envFiles: built.envFiles,
    dropped,
  };
}

/** Memo for {@link keepExistingFlag} — `tar --version` is stable per process. */
let keepExistingFlagCache: string | null = null;

/**
 * The tar flag meaning "extract, but never overwrite a file that already
 * exists" — spelled differently by the two tars we run on, with a trap:
 *
 * - **GNU tar** (Linux — what the control box's worker actually runs):
 *   `--keep-old-files` treats every existing file as an ERROR and exits
 *   non-zero, even though it correctly kept the existing copy. Its
 *   `--skip-old-files` skips silently and exits 0.
 * - **BSD tar** (macOS): has no `--skip-old-files`; `-k` skips and exits 0.
 *
 * Using `--keep-old-files` everywhere therefore worked on a developer's Mac and
 * made every conflicting overlay on the real (Linux) control box look like a
 * failure. Detect once and use the right one, so a non-zero exit means a real
 * failure on both.
 */
async function keepExistingFlag(): Promise<string> {
  if (keepExistingFlagCache) return keepExistingFlagCache;
  const v = await execa('tar', ['--version'], { reject: false });
  const isGnu = /GNU tar/i.test(`${v.stdout ?? ''}${v.stderr ?? ''}`);
  keepExistingFlagCache = isGnu ? '--skip-old-files' : '-k';
  return keepExistingFlagCache;
}

/** Fetches a seed blob by its path relative to `projects/<slug>/seed/`. */
export interface SeedSource {
  get(relPath: string): Promise<Buffer | null>;
}

export interface ApplyProjectSeedResult {
  /** Number of seed tarballs applied. */
  files: number;
  capturedAt?: string;
  repoHeadSha?: string;
  /**
   * Approved `carry:` entries, staged on this machine and rewritten to point at
   * the staging dir. Handed to `provider.create({ carry })` so the control box
   * applies them exactly as a local create would.
   */
  carry?: MaterializedCarryEntry[];
}

/**
 * Overlay a project's seed material onto a fresh clone at `dest`.
 *
 * Shared by every create worker — the resident hub worker (which reads its own
 * custody store directly) and the laptop `hub worker` (which reads it
 * over HTTP) — so both apply the same rules. The blob source is injected
 * precisely so neither has to reimplement this.
 *
 * Conflict rule: **the clone wins**. A file that was untracked when the seed was
 * captured but has since been committed exists in both; the repo's version is
 * the current truth, and restoring a months-old copy over it would silently
 * revert work. `tar --keep-old-files` leaves existing paths alone.
 */
export async function applyProjectSeed(args: {
  source: SeedSource;
  /** Absolute path of the fresh checkout to overlay onto. */
  dest: string;
  /**
   * Where to unpack `carry:` payloads. Distinct from `dest` on purpose: a carry
   * entry's destination is an arbitrary in-box path (`~/.config/...`), not
   * necessarily inside the workspace, so it cannot just be overlaid onto the
   * checkout. Omitted → carry material is ignored.
   */
  carryStageDir?: string;
  log?: (line: string) => void;
}): Promise<ApplyProjectSeedResult | null> {
  const log = args.log ?? (() => {});
  const manifestBlob = await args.source.get('manifest.json').catch(() => null);
  if (!manifestBlob) return null;
  let manifest: { createdAt?: string; repoHeadSha?: string } = {};
  try {
    manifest = JSON.parse(manifestBlob.toString('utf8')) as typeof manifest;
  } catch {
    // A corrupt manifest costs only the staleness line in the log.
  }

  const skipFlag = await keepExistingFlag();
  let files = 0;
  for (const name of ['untracked.tar.gz', 'env.tar.gz']) {
    const blob = await args.source.get(name).catch(() => null);
    if (!blob) continue;
    const tmp = join(tmpdir(), `agentbox-seed-${process.pid}-${Date.now().toString(36)}-${name}`);
    try {
      await writeFile(tmp, blob);
      await execa('tar', ['-C', args.dest, '-xzf', tmp, skipFlag]);
      files += 1;
    } catch (err) {
      // With the right flag (see keepExistingFlag) a conflict is NOT an error,
      // so reaching here means the extract genuinely failed and the box may
      // lack some seed files.
      log(
        `seed: ${name} could not be applied: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
  const carry = await materializeCarrySeed(args.source, args.carryStageDir, log);
  return {
    files,
    capturedAt: manifest.createdAt,
    repoHeadSha: manifest.repoHeadSha,
    ...(carry ? { carry } : {}),
  };
}

/**
 * Unpack `carry.tar.gz` + `carry.json` into `stageDir` and rebuild the entries
 * with `absSrc` pointing at the extracted copies.
 *
 * The result is fed straight to `provider.create({ carry })`, so from there the
 * control box runs the SAME `applyCarry` a local create does — placeholder
 * rendering included, now with a real box context. Nothing about carry semantics
 * is reimplemented here; this only moves the bytes to where the provider expects
 * them.
 *
 * Returns null when the project has no carry material (the common case).
 */
async function materializeCarrySeed(
  source: SeedSource,
  stageDir: string | undefined,
  log: (line: string) => void,
): Promise<MaterializedCarryEntry[] | null> {
  if (!stageDir) return null;
  const metaBlob = await source.get('carry.json').catch(() => null);
  if (!metaBlob) return null;
  let meta: CarrySeedManifest;
  try {
    meta = JSON.parse(metaBlob.toString('utf8')) as CarrySeedManifest;
  } catch (err) {
    throw new CarrySeedError(
      `carry: the stored carry.json is unreadable (${err instanceof Error ? err.message : String(err)}); ` +
        're-run the create from the PC to refresh it',
      { cause: err },
    );
  }
  if (!Array.isArray(meta.entries) || meta.entries.length === 0) return null;

  const tarBlob = await source.get('carry.tar.gz').catch(() => null);
  if (!tarBlob) {
    // Metadata without payload means a partial push. Loud, not silent: the box
    // would otherwise come up missing files the user approved.
    throw new CarrySeedError(
      'carry: carry.json is stored but carry.tar.gz is missing — the seed push was incomplete. ' +
        'Re-run the create from the PC.',
    );
  }

  // Wrapped: a `tar`/fs failure here throws a generic execa error, and every
  // caller between this and the create treats a non-carry error as best-effort
  // seed loss — so an unwrapped throw would build the box WITHOUT the approved
  // files and only log about it.
  try {
    await mkdir(stageDir, { recursive: true });
    const tmp = join(stageDir, 'carry.tar.gz');
    await writeFile(tmp, tarBlob);
    await execa('tar', ['-C', stageDir, '-xzf', tmp]);
    await rm(tmp, { force: true }).catch(() => {});
  } catch (err) {
    throw new CarrySeedError(
      `carry: could not unpack the approved entries: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const entries = meta.entries.map((e) => ({
    rawSrc: e.rawSrc,
    rawDest: e.rawDest,
    absSrc: join(stageDir, String(e.index), e.basename),
    absDest: e.absDest,
    kind: e.kind,
    ...(e.mode !== undefined ? { mode: e.mode } : {}),
    ...(e.user !== undefined ? { user: e.user } : {}),
    optional: e.optional,
    ...(e.exclude ? { exclude: e.exclude } : {}),
    ...(e.replaceEnvs !== undefined ? { replaceEnvs: e.replaceEnvs } : {}),
    ...(e.replace ? { replace: e.replace } : {}),
    ...(e.symlinkInfo ? { symlinkInfo: e.symlinkInfo } : {}),
  }));
  log(`carry: staged ${String(entries.length)} approved entry/entries from custody`);
  return entries;
}

/** A carry entry rebuilt against the control box's staging dir. */
export interface MaterializedCarryEntry {
  rawSrc: string;
  rawDest: string;
  absSrc: string;
  absDest: string;
  kind: 'file' | 'dir';
  mode?: number;
  user?: number;
  optional: boolean;
  exclude?: string[];
  replaceEnvs?: boolean;
  replace?: unknown[];
  symlinkInfo?: 'safe' | 'outside-home';
}

function encodeCustodyPath(path: string): string {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
