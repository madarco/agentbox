import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { execInBox, inspectVolumeMountpoint } from './docker.js';
import type { BoxRecord } from './state.js';

export type DockerEngine = 'orbstack' | 'docker-desktop' | 'other';

/** In-container paths bind-mounted to per-box host dirs by createBox. */
export const CONTAINER_EXPORT_MERGED = '/host-export';
export const CONTAINER_EXPORT_UPPER = '/host-export-upper';

/** Layer the user wants to look at. */
export type ExportLayer = 'merged' | 'upper';

export interface HostPaths {
  /** Per-box runtime dir on host, e.g. ~/.agentbox/boxes/<id>. */
  boxDir: string;
  /** Snapshot target for the merged /workspace view. */
  mergedExport: string;
  /** Snapshot target for /upper/upper (used on engines without a live host path). */
  upperExport: string;
  /**
   * Native host path to the upper named volume's `upper/` subdir on OrbStack —
   * a live, zero-copy view of the writes layer. Null on Docker Desktop and any
   * engine where the volume isn't browsable from the Mac filesystem.
   */
  upperLiveOnHost: string | null;
}

let cachedEngine: DockerEngine | null = null;

/**
 * Inspect the docker daemon to decide which host-side conventions apply.
 * `docker info --format '{{.OperatingSystem}}'` returns strings like
 * "OrbStack" or "Docker Desktop" — we only care about those two on macOS.
 */
export async function detectEngine(): Promise<DockerEngine> {
  if (cachedEngine !== null) return cachedEngine;
  const result = await execa('docker', ['info', '--format', '{{.OperatingSystem}}'], {
    reject: false,
  });
  const os = (result.stdout ?? '').trim().toLowerCase();
  if (os.includes('orbstack')) cachedEngine = 'orbstack';
  else if (os.includes('docker desktop')) cachedEngine = 'docker-desktop';
  else cachedEngine = 'other';
  return cachedEngine;
}

/** Test-only escape hatch — let unit tests bypass the docker call. */
export function __setEngineForTesting(engine: DockerEngine | null): void {
  cachedEngine = engine;
}

export const BOXES_ROOT = join(homedir(), '.agentbox', 'boxes');

export function boxRunDirFor(id: string): string {
  return join(BOXES_ROOT, id);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the host-visible path to the upper volume's writes layer for live
 * browsing.
 *
 * OrbStack exposes named volumes at `~/OrbStack/docker/volumes/<name>/` —
 * note: NO `_data` subdir; the volume contents (here: our overlay's `upper/`
 * and `work/`) appear directly. `docker volume inspect` still reports the
 * in-VM `/var/lib/docker/volumes/.../_data` mountpoint, which isn't reachable
 * from macOS, so we ignore it and use the OrbStack-shared path instead.
 *
 * Docker Desktop has no equivalent host path — returns null.
 */
export async function resolveUpperLiveOnHost(
  upperVolume: string,
  engine: DockerEngine,
): Promise<string | null> {
  if (engine !== 'orbstack') return null;
  // Primary: OrbStack's documented shared folder. Contents of the volume sit
  // directly under <vol>/ — no _data wrapper.
  const orbPath = join(homedir(), 'OrbStack', 'docker', 'volumes', upperVolume, 'upper');
  if (await pathExists(orbPath)) return orbPath;
  // Fallback: if docker reports a real-looking host mountpoint (e.g. on Linux
  // hosts or unusual setups), trust it.
  const mp = await inspectVolumeMountpoint(upperVolume);
  if (mp && !mp.startsWith('/var/lib/docker')) {
    const candidate = join(mp, 'upper');
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

export async function getHostPaths(
  record: Pick<BoxRecord, 'id' | 'upperVolume'>,
  engine?: DockerEngine,
): Promise<HostPaths> {
  const eng = engine ?? (await detectEngine());
  const boxDir = boxRunDirFor(record.id);
  return {
    boxDir,
    mergedExport: join(boxDir, 'workspace'),
    upperExport: join(boxDir, 'upper'),
    upperLiveOnHost: await resolveUpperLiveOnHost(record.upperVolume, eng),
  };
}

export interface RefreshOptions {
  layer: ExportLayer;
  /** When true, include /workspace/node_modules in the merged export. Off by default. */
  includeNodeModules?: boolean;
}

export interface RefreshResult {
  /** Host path that now reflects the box's current state. */
  hostPath: string;
  /** True when an rsync/tar copy actually ran. False when the OrbStack live path was used directly. */
  copied: boolean;
  /** True when the box predates the /host-export bind and we used the tar-pipe fallback. */
  usedFallback: boolean;
}

interface RefreshContext {
  hostBoxDir: string;
  hostTarget: string;
  containerSource: string;
  containerBind: string;
  excludeNodeModules: boolean;
}

async function hasContainerPath(container: string, path: string): Promise<boolean> {
  const probe = await execInBox(container, ['test', '-d', path], { user: 'root' });
  return probe.exitCode === 0;
}

/**
 * Refresh a per-box host export so Finder sees the box's current state.
 *
 * Strategy:
 *  - For OrbStack + layer=upper, no copy is needed — the named volume is live
 *    on disk. Caller should prefer `hostPaths.upperLiveOnHost`.
 *  - Otherwise rsync from the in-container source (`/workspace` or
 *    `/upper/upper`) to the bind-mounted host dir (`/host-export` or
 *    `/host-export-upper`).
 *  - Boxes created before the bind-mounts existed fall back to streaming a
 *    `tar | tar` through `docker exec` into the host dir directly.
 */
export async function refreshExport(
  record: Pick<BoxRecord, 'id' | 'container' | 'upperVolume'>,
  opts: RefreshOptions,
): Promise<RefreshResult> {
  const engine = await detectEngine();
  const paths = await getHostPaths(record, engine);

  if (opts.layer === 'upper' && engine === 'orbstack' && paths.upperLiveOnHost) {
    await mkdir(paths.boxDir, { recursive: true });
    return { hostPath: paths.upperLiveOnHost, copied: false, usedFallback: false };
  }

  const ctx: RefreshContext =
    opts.layer === 'merged'
      ? {
          hostBoxDir: paths.boxDir,
          hostTarget: paths.mergedExport,
          containerSource: '/workspace',
          containerBind: CONTAINER_EXPORT_MERGED,
          excludeNodeModules: !opts.includeNodeModules,
        }
      : {
          hostBoxDir: paths.boxDir,
          hostTarget: paths.upperExport,
          containerSource: '/upper/upper',
          containerBind: CONTAINER_EXPORT_UPPER,
          excludeNodeModules: false,
        };

  await mkdir(ctx.hostTarget, { recursive: true });

  const bindAvailable = await hasContainerPath(record.container, ctx.containerBind);
  if (bindAvailable) {
    const args = ['rsync', '-a', '--delete'];
    if (ctx.excludeNodeModules) args.push('--exclude=node_modules');
    args.push(`${ctx.containerSource}/`, `${ctx.containerBind}/`);
    const r = await execInBox(record.container, args, { user: 'root' });
    if (r.exitCode !== 0) {
      throw new ExportError(`rsync into ${ctx.containerBind} failed`, r.stdout, r.stderr);
    }
    return { hostPath: ctx.hostTarget, copied: true, usedFallback: false };
  }

  // Fallback for pre-existing boxes: stream a tar through docker exec into the
  // host target. Slower and skips the in-place delete that rsync gives us, but
  // it works without recreating the container.
  const excludes = ctx.excludeNodeModules ? ['--exclude=node_modules'] : [];
  const result = await execa(
    'docker',
    ['exec', '--user', 'root', record.container, 'tar', '-cf', '-', ...excludes, '-C', ctx.containerSource, '.'],
    { reject: false, encoding: 'buffer' },
  );
  if (result.exitCode !== 0) {
    throw new ExportError(
      `tar from ${ctx.containerSource} failed`,
      '',
      typeof result.stderr === 'string' ? result.stderr : (result.stderr as Buffer).toString('utf8'),
    );
  }
  const extract = await execa('tar', ['-xf', '-', '-C', ctx.hostTarget], {
    input: result.stdout as Buffer,
    reject: false,
  });
  if (extract.exitCode !== 0) {
    throw new ExportError('tar extract on host failed', extract.stdout, extract.stderr);
  }
  return { hostPath: ctx.hostTarget, copied: true, usedFallback: true };
}

export interface OpenOptions extends RefreshOptions {
  /** When true, skip rsync and just open whatever's already on disk. */
  noRefresh?: boolean;
  /** When true, refresh as usual but don't launch macOS `open` on the resulting path. */
  noOpen?: boolean;
}

export interface OpenResult {
  hostPath: string;
  copied: boolean;
  usedFallback: boolean;
  engine: DockerEngine;
}

/**
 * Refresh the requested export (unless suppressed) and launch the macOS
 * `open` command on it. Returns the host path that was opened.
 *
 * Set `noOpen: true` to refresh and return the path without launching
 * Finder — used by `agentbox open --print` so scripted callers get a
 * fresh path in one call.
 */
export async function openInFinder(
  record: Pick<BoxRecord, 'id' | 'container' | 'upperVolume'>,
  opts: OpenOptions,
): Promise<OpenResult> {
  const engine = await detectEngine();
  let hostPath: string;
  let copied = false;
  let usedFallback = false;

  if (opts.noRefresh) {
    const paths = await getHostPaths(record, engine);
    if (opts.layer === 'upper' && engine === 'orbstack' && paths.upperLiveOnHost) {
      hostPath = paths.upperLiveOnHost;
    } else {
      hostPath = opts.layer === 'merged' ? paths.mergedExport : paths.upperExport;
      await mkdir(hostPath, { recursive: true });
    }
  } else {
    const refreshed = await refreshExport(record, opts);
    hostPath = refreshed.hostPath;
    copied = refreshed.copied;
    usedFallback = refreshed.usedFallback;
  }

  if (!opts.noOpen) {
    const opened = await execa('open', [hostPath], { reject: false });
    if (opened.exitCode !== 0) {
      throw new ExportError(`open ${hostPath} failed`, opened.stdout, opened.stderr);
    }
  }

  return { hostPath, copied, usedFallback, engine };
}

export class ExportError extends Error {
  constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`${message}${stderr ? `: ${stderr.trim()}` : ''}`);
    this.name = 'ExportError';
  }
}
