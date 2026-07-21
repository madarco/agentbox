/**
 * Cross-provider versioning primitives for `~/.agentbox/<provider>-prepared.json`.
 *
 * Each provider records what it has baked (docker image / hetzner snapshot /
 * daytona snapshot) under a per-provider JSON file with a shared `base.*`
 * substructure so the CLI can detect when the on-disk artifact is stale
 * relative to the current CLI's build context.
 *
 * The invalidation key is `base.contextSha256`: a deterministic SHA-256
 * over every file in the build context (Dockerfile + scripts + baked
 * config), keyed by the file's relative path. Two CLIs with the same
 * staged runtime tree produce the same hash; an edit to any baked asset
 * — even a one-byte tweak to `custom-system-CLAUDE.md` — flips it.
 *
 * Checkpoints embed the captured `contextSha256` so restoring an older
 * checkpoint can warn the user that the baked layers predate the current
 * base image.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve as pathResolve } from 'node:path';

import type { ProviderKind } from '@agentbox/config';

/**
 * Providers that bake a `~/.agentbox/<provider>-prepared.json` artifact. The
 * built-in set is the config `ProviderKind`; the `(string & {})` arm keeps
 * autocomplete for those while also admitting an external plugin's open-string
 * provider name (a plugin manages its own prepared-state — see docs/provider-plugins.md).
 */
export type PreparedProviderKind = ProviderKind | (string & {});

/**
 * The cross-provider record. `TImage` is the provider's opaque image
 * identifier: a string tag for docker/daytona, a numeric image id for
 * hetzner. The `TExtra` slot lets a provider attach provider-specific
 * fields (e.g. hetzner's `description` and `projects[]`) without forking
 * the whole shape.
 */
export interface PreparedBaseSnapshot<TImage = string, TExtra = unknown> {
  /** Schema version. Bumped when the on-disk shape changes incompatibly. */
  schema: number;
  base?: {
    /** Provider-opaque image identifier (docker tag | hetzner imageId | daytona snapshot name). */
    imageRef: TImage;
    /** Deterministic SHA-256 of the build context — the invalidation key. */
    contextSha256: string;
    /** Informational: CLI version that produced this artifact. */
    cliVersion: string;
    /** Informational: git short SHA injected at CLI build time (or 'dev'). */
    cliCommit?: string;
    /** ISO timestamp of bake completion. */
    createdAt: string;
  };
  /** Provider-specific extras (e.g. hetzner's per-project snapshot tier). */
  extras?: TExtra;
}

export function preparedStatePathFor(provider: PreparedProviderKind): string {
  // The name lands in a filename; a plugin's open-string name could otherwise
  // carry a path separator. Provider names are `[a-z0-9-]` by convention — reject
  // anything else rather than resolve outside ~/.agentbox.
  if (!/^[A-Za-z0-9._-]+$/.test(provider)) {
    throw new Error(`invalid provider name for prepared-state: ${JSON.stringify(provider)}`);
  }
  return pathResolve(homedir(), '.agentbox', `${provider}-prepared.json`);
}

/**
 * Read the prepared-state file for `provider`. Returns `null` when the file
 * is missing, malformed, or carries a schema this code doesn't recognise —
 * callers treat all three as "rebuild needed". Sync so it can run from
 * non-async setup paths (mirrors the hetzner helper it generalises).
 */
export function readPreparedStateRaw(provider: PreparedProviderKind): unknown {
  const path = preparedStatePathFor(provider);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Atomic write: write to `<path>.tmp` then rename. `mode: 0o600` because
 * the file is informational but lives alongside `secrets.env` — same dir,
 * same permissions hygiene.
 */
export function writePreparedStateRaw(provider: PreparedProviderKind, state: unknown): void {
  const path = preparedStatePathFor(provider);
  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify(state, null, 2) + '\n';
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
}

export async function sha256OfFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

export interface ContextFile {
  /**
   * Logical relative path. Used as the canonical key for hash determinism
   * — two stagings with identical contents but different absolute paths
   * must hash the same.
   */
  rel: string;
  /** Absolute path the file is read from. */
  abs: string;
}

/**
 * Deterministic hash over a set of context files. Entries are sorted by
 * `rel` then hashed as `<rel>\0<sha256(file)>\n` lines into a final SHA-256.
 *
 * - Sort order = determinism (the caller can pass files in any order).
 * - NUL separator = no collision between a `rel` ending in hex and the
 *   following digest.
 * - Trailing newline per record = stable framing.
 *
 * Missing files raise — silently skipping would let a partial dev rebuild
 * stamp a hash that doesn't represent what's actually in the image.
 */
export async function computeContextSha256(files: ContextFile[]): Promise<string> {
  const sorted = [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const outer = createHash('sha256');
  for (const f of sorted) {
    const inner = await sha256OfFile(f.abs);
    outer.update(`${f.rel}\0${inner}\n`);
  }
  return outer.digest('hex');
}

/** Short form for log lines — first 12 hex chars of a sha256. */
export function shortFingerprint(sha: string): string {
  return sha.slice(0, 12);
}

/**
 * Fold the Claude install method into a base context fingerprint so switching
 * `box.claudeInstall` native↔npm forces a re-bake. `native` returns the base
 * hash unchanged — existing native snapshots keep their fingerprint and never
 * spuriously rebuild; only `npm` derives a distinct hash.
 */
export function claudeInstallFingerprint(baseSha: string, mode: 'native' | 'npm'): string {
  if (mode === 'native') return baseSha;
  return createHash('sha256').update(`${baseSha}\0claude-install=npm`).digest('hex');
}

/**
 * CLI version stamps set by `apps/cli/src/index.ts` at startup via env vars
 * (the values themselves come from tsup's build-time `define`). Providers
 * record them onto prepared-state files and checkpoint manifests so a stale
 * artifact carries a human-readable hint about which CLI built it.
 *
 * Fallbacks cover the unit-test and unbundled-dev paths (the CLI never
 * loaded, env unset). `unknown` is a sentinel — never a real version.
 */
export interface CliStamp {
  cliVersion: string;
  cliCommit: string;
}

export function readCliStamp(): CliStamp {
  return {
    cliVersion: process.env.AGENTBOX_CLI_VERSION ?? 'unknown',
    cliCommit: process.env.AGENTBOX_CLI_COMMIT ?? 'unknown',
  };
}

/**
 * Canonical map of files that go into the Docker base image build context
 * — every file `Dockerfile.box` COPYs, plus the Dockerfile itself. Two
 * layouts resolve the same logical entries:
 *
 *   - staged: `<contextDir>/<staged>` (production CLI runtime + dev with `apps/cli/runtime/docker`)
 *   - dev:    `<sandboxDockerRoot>/<dev>` (workspace dev, no staged tree)
 *
 * Shared across providers because:
 *   - sandbox-docker uses it to fingerprint its locally-built image.
 *   - sandbox-daytona uses it to fingerprint the snapshot it bakes from the
 *     same Dockerfile.box + the daytona-specific CLAUDE.md overlay.
 *
 * If you add a COPY line to `Dockerfile.box`, add the file here AND in
 * `apps/cli/scripts/stage-runtime.mjs` — failure to do so means the image
 * won't get re-built when that file changes.
 */
export const DOCKER_CONTEXT_FILE_MAP: Record<string, { staged: string; dev: string }> = {
  'Dockerfile.box': { staged: 'Dockerfile.box', dev: 'Dockerfile.box' },
  'ctl/bin.cjs': {
    staged: 'packages/ctl/dist/bin.cjs',
    dev: '../ctl/dist/bin.cjs',
  },
  'share/agentbox-setup/SKILL.md': {
    staged: 'apps/cli/share/agentbox-setup/SKILL.md',
    dev: '../../apps/cli/share/agentbox-setup/SKILL.md',
  },
  'scripts/agentbox-vnc-start': {
    staged: 'packages/sandbox-docker/scripts/agentbox-vnc-start',
    dev: 'scripts/agentbox-vnc-start',
  },
  'scripts/agentbox-dockerd-start': {
    staged: 'packages/sandbox-docker/scripts/agentbox-dockerd-start',
    dev: 'scripts/agentbox-dockerd-start',
  },
  'scripts/agentbox-checkpoint-cleanup': {
    staged: 'packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup',
    dev: 'scripts/agentbox-checkpoint-cleanup',
  },
  'scripts/agentbox-open': {
    staged: 'packages/sandbox-docker/scripts/agentbox-open',
    dev: 'scripts/agentbox-open',
  },
  'scripts/custom-system-CLAUDE.md': {
    staged: 'packages/sandbox-docker/scripts/custom-system-CLAUDE.md',
    dev: 'scripts/custom-system-CLAUDE.md',
  },
  'scripts/claude-managed-settings.json': {
    staged: 'packages/sandbox-docker/scripts/claude-managed-settings.json',
    dev: 'scripts/claude-managed-settings.json',
  },
  'scripts/agentbox-codex-hooks.json': {
    staged: 'packages/sandbox-docker/scripts/agentbox-codex-hooks.json',
    dev: 'scripts/agentbox-codex-hooks.json',
  },
};

/**
 * Resolve every entry in `fileMap` to an absolute path. Tries `<contextDir>/<staged>`
 * first; falls back to `<devRoot>/<dev>`. Returns `null` if any required file
 * is missing — callers treat that as "can't fingerprint" and skip the
 * cache-hit shortcut. Pure (no I/O beyond `existsSync`), so safe for use
 * from the provider's prepare path.
 */
export function resolveContextFilesFrom(
  fileMap: Record<string, { staged: string; dev: string }>,
  opts: { contextDir: string; devRoot: string },
): ContextFile[] | null {
  const out: ContextFile[] = [];
  for (const [rel, paths] of Object.entries(fileMap)) {
    const candidates = [
      pathResolve(opts.contextDir, paths.staged),
      pathResolve(opts.devRoot, paths.dev),
    ];
    const hit = candidates.find((p) => existsSync(p));
    if (!hit) return null;
    out.push({ rel, abs: hit });
  }
  return out;
}
