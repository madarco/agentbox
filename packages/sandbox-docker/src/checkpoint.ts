import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execa } from 'execa';
import {
  hashProjectPath,
  projectDirSegment,
  sanitizeMnemonic,
  setConfigValue,
} from '@agentbox/config';
import { execInBox, removeImage } from './docker.js';
import { DEFAULT_BOX_IMAGE } from './image.js';
import type { BoxRecord, GitWorktreeRecord } from './state.js';

export const CHECKPOINTS_ROOT = join(homedir(), '.agentbox', 'checkpoints');

/**
 * All per-project checkpoint *image* tags share this prefix. `prune --all`
 * allowlists by it (parallel to the old volume prefix) and `agentbox status`
 * /`inspect` recognizes a box's image as a checkpoint from this prefix.
 */
export const CHECKPOINT_IMAGE_PREFIX = 'agentbox-ckpt-';

export type CheckpointType = 'layered' | 'flattened';

/**
 * Deterministic image tag for a project checkpoint. The repository segment is
 * keyed on the project root (same hash the per-project config dir uses) and
 * carries a mnemonic suffix so `docker images` reads self-describing. The
 * mnemonic is joined with `_` (not `-`) so the leading 16 hex chars remain
 * unambiguous and the existing `agentbox-ckpt-*` prune glob still matches.
 * Pure — unit-tested directly.
 */
export function checkpointImageTag(projectRoot: string, name: string): string {
  const mnemonic = sanitizeMnemonic(basename(projectRoot));
  return `${CHECKPOINT_IMAGE_PREFIX}${hashProjectPath(projectRoot)}_${mnemonic}:${name}`;
}

export interface CheckpointManifest {
  schema: 2;
  name: string;
  type: CheckpointType;
  /** Local Docker image tag this checkpoint resolves to (`agentbox-ckpt-<hash>:<name>`). */
  image: string;
  /**
   * For a `layered` checkpoint, the older checkpoint refs this commit stacks
   * on — i.e. the chain the *source* box was built from (upper-most first,
   * base-most last). `[]` for a `flattened` checkpoint (self-contained,
   * exported+rebuilt as a single layer) or a layered checkpoint taken from a
   * box that itself started from bare host code.
   */
  parents: string[];
  base: 'worktree' | 'workspace';
  sourceBoxId: string;
  sourceBoxName: string;
  /**
   * Source box's per-worktree paths so a restored box can re-bind
   * `/workspace` (and `/workspace/<sub>`) without rerunning `seedWorkspace`.
   * `docker commit` does NOT capture bind-mounted content, so the captured
   * image's `/workspace` is empty — the actual worktree files live under
   * `gitWorktreePath` (preserved in the image's writable layer). On restore,
   * `bindWorktrees` reads these to wire the binds back. Absent only for
   * no-git boxes (their `seedWorkspaceFromDir` puts files directly in
   * `/workspace`, which the bind logic doesn't touch).
   */
  worktrees?: GitWorktreeRecord[];
  createdAt: string;
}

export interface CheckpointInfo {
  name: string;
  /** Host dir holding `manifest.json` (`~/.agentbox/checkpoints/<hash>/<name>`). */
  dir: string;
  manifest: CheckpointManifest;
}

export function projectCheckpointsDir(projectRoot: string): string {
  return join(CHECKPOINTS_ROOT, projectDirSegment(projectRoot));
}

function checkpointDir(projectRoot: string, name: string): string {
  return join(projectCheckpointsDir(projectRoot), name);
}

async function readManifest(dir: string): Promise<CheckpointManifest | null> {
  try {
    const raw = await readFile(join(dir, 'manifest.json'), 'utf8');
    const m = JSON.parse(raw) as CheckpointManifest;
    if (m.schema !== 2) return null;
    return m;
  } catch {
    return null;
  }
}

export async function listCheckpoints(projectRoot: string): Promise<CheckpointInfo[]> {
  const root = projectCheckpointsDir(projectRoot);
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: CheckpointInfo[] = [];
  for (const name of entries) {
    const dir = join(root, name);
    const manifest = await readManifest(dir);
    if (manifest) out.push({ name, dir, manifest });
  }
  out.sort((a, b) => a.manifest.createdAt.localeCompare(b.manifest.createdAt));
  return out;
}

export async function resolveCheckpoint(
  projectRoot: string,
  ref: string,
): Promise<CheckpointInfo | null> {
  const dir = checkpointDir(projectRoot, ref);
  const manifest = await readManifest(dir);
  if (!manifest) return null;
  return { name: ref, dir, manifest };
}

/**
 * Walk every per-project checkpoint manifest under CHECKPOINTS_ROOT and
 * return the union of their `image` tags. Used by `pruneBoxes({ all: true })`
 * to keep an image alive as long as any manifest on disk points at it —
 * destroy leaves the checkpoint behind by design, and the user expects to
 * still be able to start a new box from it long after the source box is gone.
 *
 * Best-effort, matching listSnapshotDirs / listBoxDirs in lifecycle.ts:
 * missing root, unreadable / non-schema-2 manifests, and non-directory
 * entries at any level are all skipped silently.
 */
export async function listAllCheckpointImages(): Promise<string[]> {
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(CHECKPOINTS_ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const proj of projectDirs) {
    const projPath = join(CHECKPOINTS_ROOT, proj);
    let names: string[];
    try {
      names = (await readdir(projPath, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of names) {
      const manifest = await readManifest(join(projPath, name));
      if (manifest) out.add(manifest.image);
    }
  }
  return Array.from(out);
}

export async function removeCheckpoint(projectRoot: string, ref: string): Promise<boolean> {
  const dir = checkpointDir(projectRoot, ref);
  const manifest = await readManifest(dir);
  if (!manifest) return false;
  await rm(dir, { recursive: true, force: true });
  // Image is the durable artifact; best-effort because nothing else references
  // it once the manifest is gone. `-f` so a stale tag without containers is
  // dropped even if Docker considers it "in use" via dangling layers.
  await removeImage(manifest.image, { force: true });
  return true;
}

/**
 * Next `<boxName>-<n>` given the names already present. Monotonic per
 * box-name; gaps from deleted checkpoints are skipped (max+1, never
 * recycled). Pure — unit-tested directly.
 */
export function computeNextCheckpointName(existingNames: string[], boxName: string): string {
  const re = new RegExp(`^${boxName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  let max = 0;
  for (const n of existingNames) {
    const m = re.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${boxName}-${String(max + 1)}`;
}

async function nextCheckpointName(projectRoot: string, boxName: string): Promise<string> {
  const existing = await listCheckpoints(projectRoot);
  return computeNextCheckpointName(
    existing.map((c) => c.name),
    boxName,
  );
}

function chainDepth(box: BoxRecord): number {
  return box.checkpointSource?.chain.length ?? 0;
}

export interface CreateCheckpointOptions {
  box: BoxRecord;
  projectRoot: string;
  name?: string;
  /** Force a flattened (export+`FROM scratch` rebuild) capture. */
  merged?: boolean;
  setDefault?: boolean;
  /**
   * If an existing checkpoint has the same name, delete it (manifest + image)
   * before capturing. Without this, name collisions throw `CheckpointError`.
   * Useful for idempotent re-runs from the in-box agent (`agentbox-ctl
   * checkpoint --replace`), e.g. when the previous invocation's stdout was
   * lost mid-flight and the agent can't tell whether it succeeded.
   */
  replace?: boolean;
  /** checkpoint.maxLayers — auto-flatten when the source chain is at/over this. */
  maxLayers: number;
  onLog?: (line: string) => void;
}

/**
 * Run the pre-commit cleanup in the box. Script is image-baked at
 * /usr/local/bin/agentbox-checkpoint-cleanup. Best-effort: a non-zero exit
 * from the cleanup logs but does not abort the capture (the script itself
 * is also `set +e` for the same reason).
 */
async function runCleanup(container: string, log: (line: string) => void): Promise<void> {
  const r = await execInBox(container, ['/usr/local/bin/agentbox-checkpoint-cleanup'], {
    user: 'root',
  });
  if (r.exitCode !== 0) {
    log(`warning: checkpoint cleanup exited ${String(r.exitCode)}: ${r.stderr.slice(0, 200)}`);
  }
}

/**
 * Read the base image's Config block so the flatten step can replay
 * Env/Cmd/Entrypoint/WorkingDir/User/ExposedPorts on the `FROM scratch`
 * rebuild. (`docker export` discards every Config field.)
 */
async function inspectImageConfig(imageRef: string): Promise<DockerImageConfig> {
  const r = await execa('docker', ['image', 'inspect', imageRef], { reject: false });
  if (r.exitCode !== 0) {
    throw new CheckpointError(`docker image inspect ${imageRef} failed`, r.stdout, r.stderr);
  }
  const parsed = JSON.parse(r.stdout) as Array<{ Config: DockerImageConfig }>;
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed[0]?.Config) {
    throw new CheckpointError(`unexpected docker image inspect shape for ${imageRef}`, r.stdout, '');
  }
  return parsed[0].Config;
}

interface DockerImageConfig {
  Env?: string[];
  Cmd?: string[];
  Entrypoint?: string[] | null;
  WorkingDir?: string;
  User?: string;
  ExposedPorts?: Record<string, unknown>;
}

/**
 * Per-instance env keys that `docker commit` picks up from the running
 * container's Config and that must NOT be baked into a project-shared
 * checkpoint image. `runBox -e` sets these per launch; persisting them
 * would leak another box's relay token / VNC password / box-id into every
 * future box restored from this checkpoint.
 */
const RUNTIME_ENV_BLOCKLIST = new Set([
  'AGENTBOX',
  'AGENTBOX_BOX_ID',
  'AGENTBOX_BOX_NAME',
  'AGENTBOX_HOST_WORKSPACE',
  'AGENTBOX_PROJECT_ROOT',
  'AGENTBOX_PROJECT_INDEX',
  'AGENTBOX_RELAY_URL',
  'AGENTBOX_RELAY_TOKEN',
  'AGENTBOX_VNC_PASSWORD',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
]);

/**
 * Render the Dockerfile lines that replay an image's Config on top of a
 * `FROM scratch\nADD rootfs.tar /` base. Each Env entry becomes its own ENV
 * line (the Dockerfile `ENV KEY=value` form is the only one that safely
 * handles `=` in values). Per-instance env keys (RUNTIME_ENV_BLOCKLIST) are
 * stripped — those come from `docker run -e` at the source box's launch and
 * must not leak into a project-shared checkpoint image.
 * Cmd/Entrypoint are emitted in their JSON exec form.
 */
function renderConfigDirectives(cfg: DockerImageConfig): string[] {
  const lines: string[] = [];
  for (const kv of cfg.Env ?? []) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const k = kv.slice(0, eq);
    if (RUNTIME_ENV_BLOCKLIST.has(k)) continue;
    const v = kv.slice(eq + 1);
    lines.push(`ENV ${k}=${dockerfileQuote(v)}`);
  }
  if (cfg.WorkingDir) lines.push(`WORKDIR ${cfg.WorkingDir}`);
  if (cfg.User) lines.push(`USER ${cfg.User}`);
  for (const p of Object.keys(cfg.ExposedPorts ?? {})) lines.push(`EXPOSE ${p.replace('/tcp', '')}`);
  if (cfg.Entrypoint && cfg.Entrypoint.length > 0) {
    lines.push(`ENTRYPOINT ${JSON.stringify(cfg.Entrypoint)}`);
  }
  if (cfg.Cmd && cfg.Cmd.length > 0) {
    lines.push(`CMD ${JSON.stringify(cfg.Cmd)}`);
  }
  return lines;
}

/** Dockerfile-safe quoting for ENV values (handles spaces and quotes). */
function dockerfileQuote(v: string): string {
  if (/^[A-Za-z0-9._/:+@,=-]+$/.test(v)) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Capture a box's accumulated state as a project checkpoint.
 *
 *  - `layered`: `docker exec /usr/local/bin/agentbox-checkpoint-cleanup` then
 *    `docker commit <container> <tag>`. Captures everything the container has
 *    written *and* the inherited image layers; the new image's parent is the
 *    container's current image (i.e. the previous checkpoint or the base).
 *  - `flattened`: same prelude, then `docker export | docker build` against
 *    a tiny `FROM scratch` Dockerfile that ADDs the rootfs tar and replays
 *    the base image's Env/Cmd/Entrypoint/WorkingDir/User/ExposedPorts. The
 *    resulting image is a single layer.
 *
 * Flattened is chosen when `--merged` is passed or the source box's chain is
 * already `>= maxLayers` deep (caps image-layer growth and reset lineage).
 */
export async function createCheckpoint(opts: CreateCheckpointOptions): Promise<CheckpointInfo> {
  const log = opts.onLog ?? (() => {});
  const { box } = opts;

  const type: CheckpointType =
    opts.merged === true || chainDepth(box) >= opts.maxLayers ? 'flattened' : 'layered';
  const name = opts.name ?? (await nextCheckpointName(opts.projectRoot, box.name));
  const dir = checkpointDir(opts.projectRoot, name);
  const existing = await readManifest(dir);
  if (existing) {
    if (opts.replace) {
      log(`replacing existing checkpoint ${name} (created ${existing.createdAt})`);
      await removeCheckpoint(opts.projectRoot, name);
    } else {
      // Surface the existing checkpoint's createdAt so a caller whose previous
      // stdout was lost (e.g. the in-box agent's harness wiping output) can
      // immediately tell whether their prior attempt succeeded. Same `rm`
      // hint, plus a `--replace` shortcut for idempotent re-runs.
      throw new CheckpointError(
        `checkpoint ${name} already exists (created ${existing.createdAt}; rm it or pass --replace to recapture)`,
        '',
        '',
      );
    }
  }
  const tag = checkpointImageTag(opts.projectRoot, name);
  await mkdir(dir, { recursive: true });

  log(`running pre-commit cleanup in ${box.container}`);
  await runCleanup(box.container, log);

  if (type === 'layered') {
    log(`docker commit ${box.container} -> ${tag} (layered)`);
    const r = await execa('docker', ['commit', box.container, tag], { reject: false });
    if (r.exitCode !== 0) {
      throw new CheckpointError(`docker commit failed for ${box.container}`, r.stdout, r.stderr);
    }
  } else {
    log(`docker commit ${box.container} -> <intermediate> (flattened path)`);
    // Two-step: commit first (so we can `docker export` from the resulting
    // image without disturbing the live container), then export+build.
    const intermediate = `${tag}-intermediate`;
    const commit = await execa('docker', ['commit', box.container, intermediate], {
      reject: false,
    });
    if (commit.exitCode !== 0) {
      throw new CheckpointError(`docker commit (intermediate) failed`, commit.stdout, commit.stderr);
    }
    try {
      await flattenImage(intermediate, tag, log);
    } finally {
      // The intermediate is layered (commits don't squash); replaced by the
      // flattened tag. -f because dangling tags would otherwise pin the
      // layered intermediate forever.
      await removeImage(intermediate, { force: true });
    }
  }

  const base: 'worktree' | 'workspace' = (box.gitWorktrees ?? []).some((w) => w.kind === 'root')
    ? 'worktree'
    : 'workspace';
  const manifest: CheckpointManifest = {
    schema: 2,
    name,
    type,
    image: tag,
    // Layered carries lineage forward; flattened is self-contained.
    parents: type === 'layered' ? (box.checkpointSource?.chain ?? []) : [],
    base,
    sourceBoxId: box.id,
    sourceBoxName: box.name,
    worktrees: box.gitWorktrees,
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  if (opts.setDefault) {
    await setConfigValue('project', 'box.defaultCheckpoint', name, opts.projectRoot);
    log(`set project default checkpoint -> ${name}`);
  }

  return { name, dir, manifest };
}

/**
 * Flatten a layered image: export its rootfs as a tar, wrap it in a tiny
 * `FROM scratch` Dockerfile that replays the source image's Config block,
 * and build the result. Leaves the source image alone (caller removes it).
 */
async function flattenImage(
  sourceTag: string,
  destTag: string,
  log: (line: string) => void,
): Promise<void> {
  // `docker export` needs a *container*, so create one without running it.
  const tmpName = `agentbox-flatten-${Date.now().toString(36)}`;
  const create = await execa(
    'docker',
    ['create', '--name', tmpName, sourceTag, 'sleep', '0'],
    { reject: false },
  );
  if (create.exitCode !== 0) {
    throw new CheckpointError(`docker create for flatten failed`, create.stdout, create.stderr);
  }
  const scratch = await mkdtemp(join(tmpdir(), 'agentbox-flatten-'));
  try {
    const rootfsPath = join(scratch, 'rootfs.tar');
    log(`exporting rootfs of ${sourceTag} to ${rootfsPath}`);
    const exp = await execa('docker', ['export', '-o', rootfsPath, tmpName], { reject: false });
    if (exp.exitCode !== 0) {
      throw new CheckpointError(`docker export failed`, exp.stdout, exp.stderr);
    }

    // The Config block to replay is the *source* image's — that's what the
    // running container saw, and `docker commit` carries it through
    // unmodified. `docker export` drops it, which is the only reason we need
    // to inspect+replay here.
    const cfg = await inspectImageConfig(sourceTag);
    const lines = [
      'FROM scratch',
      // ADD untars during build (Docker's documented behavior for local tars).
      'ADD rootfs.tar /',
      ...renderConfigDirectives(cfg),
    ];
    await writeFile(join(scratch, 'Dockerfile'), lines.join('\n') + '\n', 'utf8');

    log(`building flattened ${destTag} from rootfs.tar (FROM scratch)`);
    const build = await execa(
      'docker',
      ['build', '-t', destTag, '-f', join(scratch, 'Dockerfile'), scratch],
      { reject: false },
    );
    if (build.exitCode !== 0) {
      throw new CheckpointError(`flatten docker build failed`, build.stdout, build.stderr);
    }
  } finally {
    await execa('docker', ['rm', '-f', tmpName], { reject: false });
    await rm(scratch, { recursive: true, force: true });
  }
}

export class CheckpointError extends Error {
  constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`${message}${stderr ? `: ${stderr.trim()}` : ''}`);
    this.name = 'CheckpointError';
  }
}

/** Kept for the type-only import in `image.ts`'s self-update path. */
export const _DEFAULT_BASE_IMAGE_REF = DEFAULT_BOX_IMAGE;
