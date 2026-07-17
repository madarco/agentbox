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
import { gzipSync } from 'node:zlib';
import { execa } from 'execa';
import { scanHostEnvFiles } from '@agentbox/sandbox-core';

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
  return { items, manifest, skippedTarBytes };
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
  const built = await buildProjectSeed(args);
  const prefix = `projects/${args.slug}/seed`;
  const fetchImpl = args.fetchImpl ?? fetch;
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

  for (const item of built.items) await put(item.relPath, item.data);
  await put('manifest.json', Buffer.from(JSON.stringify(built.manifest, null, 2), 'utf8'));

  log(
    `seed: ${String(uploaded)} uploaded, ${String(skipped)} unchanged → custody ${prefix}`,
  );
  return {
    uploaded,
    skipped,
    manifest: built.manifest,
    skippedTarBytes: built.skippedTarBytes,
  };
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
