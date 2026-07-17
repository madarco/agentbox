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
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { execa } from 'execa';
import { scanHostEnvFiles } from '@agentbox/sandbox-core';
import { deadlineFetch, hostReachable } from './reachability.js';

/** Bound on the seed upload once the control box is known to be up. */
const SEED_PUSH_MS = 120_000;

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
   * The control box's custody body cap (`relay.custodyMaxBodyBytes`). The
   * untracked tar is dropped when it wouldn't fit (env + manifest still go) —
   * an oversized upload would fail the whole push, and a partial seed beats
   * none. Passing the effective config value is what makes raising that key
   * actually admit a bigger seed. Defaults to the same 32 MiB the relay does.
   */
  maxBodyBytes?: number;
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

/** Mirrors the relay's own default custody body cap. */
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Largest raw blob that still fits a `maxBodyBytes` custody PUT. The value is
 * sent as base64 inside a JSON envelope, so it inflates by 4/3; the 0.7 factor
 * is that plus headroom for the envelope itself.
 */
function maxBlobBytes(maxBodyBytes: number): number {
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
  const maxTarBytes = maxBlobBytes(args.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  const items: SeedItem[] = [];
  let skippedTarBytes: number | undefined;

  const tar = await buildUntrackedTar(args.projectRoot);
  if (tar) {
    if (tar.length > maxTarBytes) {
      skippedTarBytes = tar.length;
      log(
        `seed: untracked tar is ${formatBytes(tar.length)} (> ${formatBytes(maxTarBytes)}) — skipping it; ` +
          'env files still pushed. Raise `relay.custodyMaxBodyBytes` to include it.',
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

  const manifest: SeedManifest = {
    version: 1,
    originUrl: (await gitOut(args.projectRoot, ['remote', 'get-url', 'origin'])) ?? undefined,
    baseBranch: (await gitOut(args.projectRoot, ['branch', '--show-current'])) ?? undefined,
    repoHeadSha: (await gitOut(args.projectRoot, ['rev-parse', 'HEAD'])) ?? undefined,
    files: items.map((i) => ({ path: i.relPath, sha256: sha256Hex(i.data), bytes: i.data.length })),
    createdAt: new Date().toISOString(),
  };
  return { items, manifest, skippedTarBytes, envFiles: envRelPaths };
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
  const list = await execa('git', ['-C', repo, 'ls-files', '--others', '--exclude-standard', '-z'], {
    reject: false,
  });
  if (list.exitCode !== 0 || list.stdout.length === 0) return null;
  return tarNulList(repo, list.stdout);
}

/** Tar `relPaths` (repo-relative) out of `repo`, or null when the list is empty. */
async function buildTarOf(repo: string, relPaths: string[]): Promise<Buffer | null> {
  if (relPaths.length === 0) return null;
  return tarNulList(repo, relPaths.join('\0') + '\0');
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

export interface PushProjectSeedArgs extends BuildProjectSeedArgs {
  controlPlaneUrl: string;
  adminToken: string;
  /** Custody `projects/<slug>` key. */
  slug: string;
  /** Upload every item even when custody already holds identical bytes. */
  force?: boolean;
  fetchImpl?: typeof fetch;
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
  // create, so a down control box must not stall it on undici's ~10s connect
  // timeout (see reachability.ts). A caller-supplied fetch (tests) is used as-is.
  const fetchImpl =
    args.fetchImpl ??
    ((await hostReachable(args.controlPlaneUrl))
      ? deadlineFetch(AbortSignal.timeout(SEED_PUSH_MS))
      : null);
  if (!fetchImpl) {
    log('seed: control box unreachable — skipping the seed push');
    const empty = await buildProjectSeed({ ...args, envPatterns: undefined });
    // `unreachable` — not just zero counts. A caller that treats "0 uploaded"
    // as success would tell the user their project is registered when nothing
    // ever left the machine.
    return {
      uploaded: 0,
      skipped: 0,
      manifest: empty.manifest,
      envFiles: [],
      dropped: [],
      unreachable: true,
    };
  }
  const built = await buildProjectSeed(args);
  const prefix = `projects/${args.slug}/seed`;
  const base = args.controlPlaneUrl.replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${args.adminToken}`,
  };

  // Hash-skip against what's already stored, so an unchanged tree uploads nothing.
  const existing = new Map<string, string>();
  if (!args.force) {
    try {
      const res = await fetchImpl(`${base}/admin/custody?prefix=${encodeURIComponent(prefix)}`, {
        headers,
      });
      if (res.ok) {
        const body = (await res.json()) as { entries: Array<{ path: string; sha256: string }> };
        for (const e of body.entries) existing.set(e.path, e.sha256);
      }
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
    const res = await fetchImpl(`${base}/admin/custody/${encodeCustodyPath(path)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ data: data.toString('base64') }),
    });
    if (!res.ok) {
      throw new Error(`custody put ${path} → ${String(res.status)}`);
    }
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
      dropped.push(item.relPath);
      log(
        `seed: the control box refused ${item.relPath} (${formatBytes(item.data.length)}): ` +
          `${err instanceof Error ? err.message : String(err)} — continuing without it. ` +
          'If it is a size limit, raise AGENTBOX_CUSTODY_MAX_BODY_BYTES on the control box.',
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

/** Fetches a seed blob by its path relative to `projects/<slug>/seed/`. */
export interface SeedSource {
  get(relPath: string): Promise<Buffer | null>;
}

export interface ApplyProjectSeedResult {
  /** Number of seed tarballs applied. */
  files: number;
  capturedAt?: string;
  repoHeadSha?: string;
}

/**
 * Overlay a project's seed material onto a fresh clone at `dest`.
 *
 * Shared by every create worker — the resident hub worker (which reads its own
 * custody store directly) and the laptop `control-plane worker` (which reads it
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

  let files = 0;
  for (const name of ['untracked.tar.gz', 'env.tar.gz']) {
    const blob = await args.source.get(name).catch(() => null);
    if (!blob) continue;
    const tmp = join(tmpdir(), `agentbox-seed-${process.pid}-${Date.now().toString(36)}-${name}`);
    try {
      await writeFile(tmp, blob);
      await execa('tar', ['-C', args.dest, '-xzf', tmp, '--keep-old-files']);
      files += 1;
    } catch (err) {
      // `--keep-old-files` makes GNU tar exit non-zero on a collision even
      // though it did the right thing (kept the clone's copy), so this is not
      // necessarily fatal — the box may just lack some seed files.
      log(`seed: ${name} partially applied: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
  return { files, capturedAt: manifest.createdAt, repoHeadSha: manifest.repoHeadSha };
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
