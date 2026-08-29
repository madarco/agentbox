import { execa } from 'execa';
import {
  classifyPullFailure,
  isAuthRetryable,
  isGhcrTarget,
  loginToGhcrWithGh,
  type PullFailure,
} from './registry-auth.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  BOX_IMAGE_REGISTRY,
  claudeInstallFingerprint,
  registryRefForSha,
  type FileManifest,
  variantFingerprint,
  normalizeAgentSet,
  agentSetArg,
  resolveAgentSpec,
  renderInstallRecipe,
  renderAptInstall,
} from '@agentbox/sandbox-core';

export const DEFAULT_BOX_IMAGE = 'agentbox/box:dev';
/** Box user NAME (the uid varies per provider; the name does not). */
const BOX_USER = 'vscode';

/**
 * Resolve the effective `box.claudeInstall` for the current project. Docker
 * builds its image lazily at create time, so every `ensureImage` path must
 * agree on the mode or a native rebuild would clobber an npm-baked image (and
 * vice-versa). Lazy-imported to keep the module load cheap; falls back to
 * `native` if config can't be read.
 */
async function resolveClaudeInstallMode(): Promise<'native' | 'npm'> {
  try {
    const { loadEffectiveConfig } = await import('@agentbox/config');
    const cfg = await loadEffectiveConfig(process.cwd());
    return cfg.effective.box.claudeInstall;
  } catch {
    return 'native';
  }
}

// The registry ref lives in @agentbox/sandbox-core: daytona's linux-vm bake
// needs it too (a VM snapshot can only be built from a prebuilt registry image),
// and importing it from here would drag execa into that import graph. Re-exported
// so existing `@agentbox/sandbox-docker` consumers keep working.
export { BOX_IMAGE_REGISTRY, registryRefForSha };

const here = dirname(fileURLToPath(import.meta.url));

// The Dockerfile's COPY lines reference monorepo-relative paths
// (packages/ctl/dist/bin.cjs, apps/cli/share/..., packages/sandbox-docker/scripts/*),
// so the build context must be a dir containing that tree.
//
// Resolution order:
//   0. AGENTBOX_DOCKER_CONTEXT env override (dir holding Dockerfile.box).
//   1. Staged context shipped with the bundled `agent-box` package: this
//      module is bundled into the CLI at <root>/dist, the stage step mirrors
//      the COPY tree at <root>/runtime/docker (sibling of dist/, uniform in
//      dev and when installed).
//   2. Legacy monorepo: Dockerfile.box at the sandbox-docker package root,
//      build context = monorepo root.
function resolveDockerBuild(): { dockerfile: string; context: string } {
  const override = process.env.AGENTBOX_DOCKER_CONTEXT;
  if (override && existsSync(resolve(override, 'Dockerfile.box'))) {
    return { dockerfile: resolve(override, 'Dockerfile.box'), context: override };
  }
  const staged = resolve(here, '..', 'runtime', 'docker');
  if (existsSync(resolve(staged, 'Dockerfile.box'))) {
    return { dockerfile: resolve(staged, 'Dockerfile.box'), context: staged };
  }
  // Legacy: src/ (or the unbundled package dist/) is one level under the
  // package root; the monorepo root is two more up.
  const packageRoot = resolve(here, '..');
  return {
    dockerfile: resolve(packageRoot, 'Dockerfile.box'),
    context: resolve(packageRoot, '..', '..'),
  };
}

const { dockerfile: DOCKERFILE_PATH_RESOLVED, context: BUILD_CONTEXT_DIR_RESOLVED } =
  resolveDockerBuild();
export const DOCKERFILE_PATH = DOCKERFILE_PATH_RESOLVED;
export const BUILD_CONTEXT_DIR = BUILD_CONTEXT_DIR_RESOLVED;

export async function imageExists(ref: string): Promise<boolean> {
  const result = await execa('docker', ['image', 'inspect', ref], { reject: false });
  return result.exitCode === 0;
}

/**
 * Attempt `docker pull <target>`. Never throws.
 *
 * Reports WHY it failed, not just that it did: a rate-limited pull, a rejected
 * credential and an unpublished tag all exit 1, but only the first two can be
 * fixed by authenticating and only the third means "build locally". Returning a
 * bare boolean here is what made a throttled pull look identical to a missing
 * image — a silent ~10-minute rebuild of an image that was in the registry.
 */
export async function pullImage(
  target: string,
  opts: { onProgress?: (line: string) => void } = {},
): Promise<{ ok: boolean; failure?: PullFailure }> {
  const subprocess = execa('docker', ['pull', target], {
    stderr: 'pipe',
    stdout: 'pipe',
    reject: false,
  });
  // Kept so a failure can be classified; docker writes the real reason to stderr.
  let stderrText = '';
  // Always capture stderr, even with no onProgress — the classification below
  // needs it regardless of whether anyone is watching the progress stream.
  subprocess.stderr?.on('data', (chunk: Buffer | string) => {
    stderrText += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  });
  let heartbeat: NodeJS.Timeout | undefined;
  if (opts.onProgress) {
    let lastLineAt = Date.now();
    const forward = (chunk: Buffer | string): void => {
      lastLineAt = Date.now();
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) opts.onProgress?.(line);
      }
    };
    subprocess.stdout?.on('data', forward);
    subprocess.stderr?.on('data', forward);
    // Piped (non-TTY) `docker pull` prints nothing between the last
    // "Download complete" and each "Pull complete" — the entire extraction
    // phase is silent, which for a multi-GB image reads as a hang. Emit a
    // keepalive so the create spinner keeps moving.
    heartbeat = setInterval(() => {
      if (Date.now() - lastLineAt >= 20_000) {
        opts.onProgress?.(`still extracting ${target} — large layers can take a few minutes`);
      }
    }, 20_000);
  }
  try {
    const result = await subprocess;
    if (result.exitCode === 0) return { ok: true };
    return { ok: false, failure: classifyPullFailure(stderrText || (result.stderr ?? '')) };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

export async function tagImage(source: string, target: string): Promise<void> {
  await execa('docker', ['tag', source, target]);
}

export interface ImageInfo {
  /** Image ref (e.g. `agentbox/box:dev`). */
  ref: string;
  /** True when the engine has the image locally. */
  exists: boolean;
  /** Image size in bytes, when known. */
  sizeBytes?: number;
  /** ISO-8601 creation time, when known. */
  createdAt?: string;
}

/**
 * Read-only inspect of a Docker image. Used by `agentbox prepare` (no-args
 * status mode) to surface base-image state. Never throws — returns
 * `{ exists: false }` on any error so the status command works even when
 * the docker daemon is unreachable.
 */
export async function imageInfo(ref: string = DEFAULT_BOX_IMAGE): Promise<ImageInfo> {
  const result = await execa(
    'docker',
    ['image', 'inspect', '--format', '{{.Size}}|{{.Created}}', ref],
    { reject: false },
  );
  if (result.exitCode !== 0) return { ref, exists: false };
  const [sizeStr, createdAt] = result.stdout.trim().split('|');
  const sizeBytes = sizeStr ? Number.parseInt(sizeStr, 10) : NaN;
  return {
    ref,
    exists: true,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : undefined,
    createdAt: createdAt && createdAt.length > 0 ? createdAt : undefined,
  };
}

export interface BuildImageOptions {
  ref?: string;
  dockerfile?: string;
  contextDir?: string;
  /** `--build-arg K=V` pairs forwarded to `docker build` (e.g. AGENTBOX_CLAUDE_INSTALL). */
  buildArgs?: Record<string, string>;
  onProgress?: (line: string) => void;
}

export async function buildImage(opts: BuildImageOptions = {}): Promise<string> {
  const ref = opts.ref ?? DEFAULT_BOX_IMAGE;
  const dockerfile = opts.dockerfile ?? DOCKERFILE_PATH;
  const contextDir = opts.contextDir ?? BUILD_CONTEXT_DIR;

  // Dogfood path: when building from inside an agentbox (docker-in-docker),
  // the default bridge network can't bind-mount /proc/<pid>/ns/net for the
  // build container, breaking any RUN that needs network (e.g. apt, curl).
  // Falling back to host networking sidesteps the missing capability.
  const args = ['build', '-t', ref, '-f', dockerfile];
  for (const [k, v] of Object.entries(opts.buildArgs ?? {})) {
    args.push('--build-arg', `${k}=${v}`);
  }
  args.push(contextDir);
  if (process.env.AGENTBOX === '1') {
    args.splice(1, 0, '--network=host');
  }

  const subprocess = execa('docker', args, {
    stderr: 'pipe',
    stdout: 'pipe',
  });

  if (opts.onProgress) {
    const forward = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) opts.onProgress?.(line);
      }
    };
    subprocess.stdout?.on('data', forward);
    subprocess.stderr?.on('data', forward);
  }

  await subprocess;
  return ref;
}

export interface PullOrBuildOptions {
  onProgress?: (line: string) => void;
  /** Dockerfile path. Defaults to `Dockerfile.box` next to this package. */
  dockerfile?: string;
  /** Build context directory. Defaults to the staged runtime / monorepo root. */
  contextDir?: string;
  /** Try the registry before building. Defaults to true. */
  allowPull?: boolean;
  /** Registry repo to pull from. Defaults to `BOX_IMAGE_REGISTRY`; empty disables pulling. */
  registry?: string;
  /** `--build-arg K=V` pairs forwarded to the local `docker build` (ignored on a registry pull). */
  buildArgs?: Record<string, string>;
  /** Agent-set key this build is for, so its prepared record is kept separately. */
  variant?: string;
}

/**
 * Make `ref` present locally, preferring a registry pull over a local build.
 *
 * When `fingerprint` is non-null and pulling is allowed, pull the
 * fingerprint-tagged image and retag it to `ref`; on a miss (or when pulling
 * is disabled / unfingerprintable) build from the staged context. Either way,
 * a known fingerprint is stamped into docker-prepared.json so the next
 * `ensureImage()` treats this as a cache hit.
 */
export async function pullOrBuild(
  ref: string,
  fingerprint: { contextSha256: string; manifest?: FileManifest } | null,
  opts: PullOrBuildOptions = {},
): Promise<{ source: 'pulled' | 'built' }> {
  const { writePreparedDockerState } = await import('./prepared-state.js');
  const registry = opts.registry ?? BOX_IMAGE_REGISTRY;
  const allowPull = opts.allowPull !== false;

  if (allowPull && registry && fingerprint) {
    const target = registryRefForSha(fingerprint.contextSha256, registry);
    const succeed = async (): Promise<{ source: 'pulled' }> => {
      await tagImage(target, ref);
      writePreparedDockerState({
        imageRef: ref,
        contextSha256: fingerprint.contextSha256,
        ...(fingerprint.manifest ? { files: fingerprint.manifest } : {}),
        ...(opts.variant === undefined ? {} : { variant: opts.variant }),
      });
      opts.onProgress?.(`[image] pulled ${target} -> ${ref}`);
      return { source: 'pulled' };
    };

    opts.onProgress?.(`[image] pulling ${target}`);
    const first = await pullImage(target, { onProgress: opts.onProgress });
    if (first.ok) return succeed();

    const failure = first.failure ?? { kind: 'unknown' as const, detail: 'unknown error' };
    opts.onProgress?.(`[image] pull failed (${failure.kind}): ${failure.detail}`);

    // A throttle or a credential problem is not a missing image: the tag is
    // there and an authenticated pull gets it. GHCR's anonymous limit is per-IP
    // and a machine that just baked a few times trips it, so borrowing the
    // host's `gh` token here is the difference between a retag and a ~10-minute
    // rebuild of an image that was already published.
    if (isAuthRetryable(failure.kind) && isGhcrTarget(target)) {
      opts.onProgress?.('[image] retrying authenticated with your `gh` token');
      const login = await loginToGhcrWithGh();
      if (login.ok) {
        const second = await pullImage(target, { onProgress: opts.onProgress });
        if (second.ok) return succeed();
        const f2 = second.failure ?? { kind: 'unknown' as const, detail: 'unknown error' };
        opts.onProgress?.(`[image] authenticated pull also failed (${f2.kind}): ${f2.detail}`);
      } else {
        opts.onProgress?.(
          `[image] could not authenticate to ghcr.io: ${login.reason ?? 'unknown'}`,
        );
      }
    }

    opts.onProgress?.(`[image] building ${ref} locally instead`);
  }

  await buildImage({
    ref,
    dockerfile: opts.dockerfile,
    contextDir: opts.contextDir,
    buildArgs: opts.buildArgs,
    onProgress: opts.onProgress,
  });
  if (fingerprint) {
    writePreparedDockerState({
      imageRef: ref,
      contextSha256: fingerprint.contextSha256,
      ...(fingerprint.manifest ? { files: fingerprint.manifest } : {}),
      ...(opts.variant === undefined ? {} : { variant: opts.variant }),
    });
  }
  return { source: 'built' };
}

export interface EnsureImageOptions {
  onProgress?: (line: string) => void;
  /** Dockerfile path. Defaults to `Dockerfile.box` next to this package. */
  dockerfile?: string;
  /** Build context directory. Defaults to the monorepo root. */
  contextDir?: string;
  /** Try the registry before building. Defaults to true. */
  allowPull?: boolean;
  /** Registry repo to pull from. Defaults to `BOX_IMAGE_REGISTRY`; empty disables pulling. */
  registry?: string;
  /**
   * How Claude Code is installed into the image. Folded into the build-context
   * fingerprint so a mode switch rebuilds (and an npm image isn't clobbered by
   * a native rebuild). Defaults to the resolved `box.claudeInstall`.
   */
  claudeInstall?: 'native' | 'npm';
  /**
   * Agents to bake into the image. Folded into the fingerprint AND passed as
   * the `AGENTBOX_AGENTS` build arg, so `agentbox claude` and `agentbox codex`
   * resolve different images rather than fighting over one local tag. Empty /
   * omitted means the agentless base.
   */
  agents?: readonly string[];
}

/**
 * The local tag for a variant. The empty variant keeps the historical
 * `agentbox/box:dev` so nothing that hardcodes it moves; each agent set gets a
 * suffixed tag of its own (`agentbox/box:dev-claude`), because two boxes built
 * for different agents must not overwrite each other's image.
 */
export function variantImageRef(ref: string, agents: readonly string[] | undefined): string {
  const set = normalizeAgentSet(agents);
  return set.length === 0 ? ref : `${ref}-${set.join('-')}`;
}

/**
 * Build `derivedRef` as a thin layer on top of `baseRef` that adds `agents`.
 *
 * Deriving rather than rebuilding the whole Dockerfile with a different
 * `AGENTBOX_AGENTS` matters for size: the ARG has to be declared before the
 * per-agent home dirs, so in a full variant build EVERY later layer diverges --
 * Playwright, Chromium and the VNC stack each get their own copy per agent,
 * ~1.3 GB of duplication for a ~200 MB agent. Derived, a variant's unique bytes
 * are just the agent, and CI publishes one base image instead of one per set.
 *
 * The recipes come from the same `AGENT_SYNC_SPECS.install` data that
 * `ensureAgentInstalled` runs against a live box, so a baked agent and a
 * runtime-added one are installed identically.
 */
export async function buildDerivedAgentImage(opts: {
  baseRef: string;
  derivedRef: string;
  agents: readonly string[];
  onProgress?: (line: string) => void;
}): Promise<void> {
  const lines: string[] = [`FROM ${opts.baseRef}`];
  for (const id of opts.agents) {
    const spec = resolveAgentSpec(id);
    const { install } = spec;
    lines.push(`# ---- ${spec.id} ----`, 'USER root');
    if (install.apt && install.apt.length > 0) {
      lines.push(`RUN ${renderAptInstall(install.apt)}`);
    }
    const recipe = renderInstallRecipe(install.recipe);
    if (install.runAs === 'box-user') {
      // Native installers write into the INVOKING user's ~/.local/bin, so
      // running them as root would put the binary in /root.
      lines.push(`USER ${BOX_USER}`, `RUN ${recipe}`, 'USER root');
    } else {
      lines.push(`RUN ${recipe}`);
    }
    if (install.postInstall) lines.push(`RUN ${install.postInstall}`);
    lines.push(
      `RUN command -v ${spec.binary} >/dev/null || (echo "${spec.id} not on PATH after install" >&2; exit 71)`,
    );
  }
  // Restore the base's final USER/WORKDIR: we switched to root above.
  lines.push(`USER ${BOX_USER}`, 'WORKDIR /workspace');

  // No context files are needed -- everything is FROM + RUN -- so build from an
  // empty dir rather than re-sending the multi-hundred-MB runtime tree.
  const ctx = await mkdtemp(join(tmpdir(), 'agentbox-derive-'));
  try {
    const dockerfile = join(ctx, 'Dockerfile');
    await writeFile(dockerfile, lines.join('\n') + '\n', 'utf8');
    opts.onProgress?.(
      `[image] deriving ${opts.derivedRef} from ${opts.baseRef} (+${opts.agents.join(', ')})`,
    );
    await buildImage({
      ref: opts.derivedRef,
      dockerfile,
      contextDir: ctx,
      onProgress: opts.onProgress,
    });
  } finally {
    await rm(ctx, { recursive: true, force: true });
  }
}

export async function ensureImage(
  ref: string = DEFAULT_BOX_IMAGE,
  opts: EnsureImageOptions = {},
): Promise<{ ref: string; built: boolean; reason?: string }> {
  // Lazy import: prepared-state imports back into image.ts for the default
  // DOCKERFILE_PATH/BUILD_CONTEXT_DIR constants, so loading it at top-level
  // would create a circular ESM init order.
  const { computeDockerContextFingerprint, readPreparedDockerState, preparedMatches } =
    await import('./prepared-state.js');
  const { writePreparedDockerState } = await import('./prepared-state.js');

  const claudeInstall = opts.claudeInstall ?? (await resolveClaudeInstallMode());
  const agents = normalizeAgentSet(opts.agents);
  const baseRef = ref;
  const rawFingerprint = await computeDockerContextFingerprint({ contextDir: opts.contextDir });

  /** Is `candidateRef` present AND stamped with `sha` for `variant`? */
  const upToDate = async (candidateRef: string, sha: string, variant: string): Promise<boolean> => {
    if (!(await imageExists(candidateRef))) return false;
    const prepared = readPreparedDockerState();
    return prepared !== null && preparedMatches(prepared, sha, variant);
  };

  // ---- 1. the agentless base -------------------------------------------
  // Always the SAME image whatever agents were asked for, so every variant
  // shares its layers and CI publishes exactly one of them.
  const baseSha = rawFingerprint
    ? variantFingerprint(rawFingerprint.contextSha256, { claudeInstall })
    : null;
  const baseFingerprint =
    rawFingerprint && baseSha ? { ...rawFingerprint, contextSha256: baseSha } : null;

  let baseBuilt = false;
  let reason: string | undefined;
  if (!baseFingerprint) {
    // Couldn't enumerate the context (partial dev rebuild?). Don't rebuild
    // unconditionally — that would surprise users mid-iteration.
    if (!(await imageExists(baseRef))) {
      return {
        ref: baseRef,
        built: false,
        reason: 'base image missing and context unfingerprintable',
      };
    }
    reason = 'image present (fingerprint skipped)';
  } else if (!(await upToDate(baseRef, baseSha!, ''))) {
    opts.onProgress?.(`[image] ${baseRef}: base image out of date or missing`);
    const npm = claudeInstall === 'npm';
    const { source } = await pullOrBuild(baseRef, baseFingerprint, {
      onProgress: opts.onProgress,
      dockerfile: opts.dockerfile,
      contextDir: opts.contextDir,
      // npm mode pulls too: CI publishes both install variants and the
      // fingerprint is folded with the mode, so the pull asks for the npm
      // image's own tag and hits.
      allowPull: opts.allowPull,
      registry: opts.registry,
      variant: '',
      buildArgs: npm ? { AGENTBOX_CLAUDE_INSTALL: 'npm' } : {},
    });
    baseBuilt = source === 'built';
    reason = 'base image rebuilt';
  }

  if (agents.length === 0) {
    return { ref: baseRef, built: baseBuilt, reason: reason ?? 'image up to date' };
  }

  // ---- 2. the agent layer ----------------------------------------------
  // A thin `FROM <base>` + install, NOT a second full build: a full variant
  // build diverges at the AGENTBOX_AGENTS ARG and duplicates every later layer
  // (Playwright, Chromium, VNC) per agent.
  const variantKey = agentSetArg(agents);
  const derivedRef = variantImageRef(baseRef, agents);
  const derivedSha = baseFingerprint
    ? variantFingerprint(rawFingerprint!.contextSha256, { claudeInstall, agents })
    : null;

  if (derivedSha && (await upToDate(derivedRef, derivedSha, variantKey)) && !baseBuilt) {
    return { ref: derivedRef, built: false, reason: 'image up to date' };
  }

  await buildDerivedAgentImage({ baseRef, derivedRef, agents, onProgress: opts.onProgress });
  if (derivedSha) {
    writePreparedDockerState({
      imageRef: derivedRef,
      contextSha256: derivedSha,
      ...(rawFingerprint?.manifest ? { files: rawFingerprint.manifest } : {}),
      variant: variantKey,
    });
  }
  return {
    ref: derivedRef,
    built: true,
    reason: reason ?? `added ${agents.join(', ')} to ${baseRef}`,
  };
}

/**
 * Read-only freshness classification of the docker base image, for surfaces
 * (hub API, tray) that want to announce an upcoming bake without triggering
 * it. `unknown` means "couldn't fingerprint" and MUST stay inert — the
 * matching `ensureImage` path trusts the existing image and does not rebuild.
 */
export type DockerBaseFreshness =
  | { state: 'fresh' }
  | { state: 'unknown' }
  | { state: 'unprepared' }
  | { state: 'stale'; reason: string };

/**
 * Pure decision core shared by `evaluateDockerBaseFreshness`. Mirrors
 * `ensureImage`'s rebuild predicate exactly — if the two ever disagree, the
 * freshness surfaces would announce a bake that create then skips (or miss
 * one it performs). `stampedSha` is `docker-prepared.json`'s fingerprint,
 * null when the stamp is missing/invalid.
 */
export function classifyDockerBaseFreshness(input: {
  imagePresent: boolean;
  fingerprint: string | null;
  stampedSha: string | null;
}): DockerBaseFreshness {
  if (!input.imagePresent) return { state: 'unprepared' };
  if (!input.fingerprint) return { state: 'unknown' };
  if (!input.stampedSha) return { state: 'stale', reason: 'no docker-prepared.json on disk' };
  if (input.stampedSha !== input.fingerprint) {
    return {
      state: 'stale',
      reason:
        `build context changed (was ${input.stampedSha.slice(0, 12)}, ` +
        `now ${input.fingerprint.slice(0, 12)})`,
    };
  }
  return { state: 'fresh' };
}

/**
 * Cheap live check: would `ensureImage` bake on the next create? The only
 * docker work is one `docker image inspect`; the rest hashes the ~15 build
 * context files. Never builds, pulls, or writes the prepared stamp.
 */
export async function evaluateDockerBaseFreshness(
  opts: { ref?: string; claudeInstall?: 'native' | 'npm'; contextDir?: string } = {},
): Promise<DockerBaseFreshness> {
  // Lazy import for the same circular-init reason as in ensureImage above.
  const { computeDockerContextFingerprint, readPreparedDockerState } =
    await import('./prepared-state.js');
  const ref = opts.ref ?? DEFAULT_BOX_IMAGE;
  const imagePresent = await imageExists(ref);
  if (!imagePresent) return { state: 'unprepared' };
  const claudeInstall = opts.claudeInstall ?? (await resolveClaudeInstallMode());
  const raw = await computeDockerContextFingerprint({ contextDir: opts.contextDir });
  return classifyDockerBaseFreshness({
    imagePresent,
    fingerprint: raw ? claudeInstallFingerprint(raw.contextSha256, claudeInstall) : null,
    stampedSha: readPreparedDockerState()?.base?.contextSha256 ?? null,
  });
}
