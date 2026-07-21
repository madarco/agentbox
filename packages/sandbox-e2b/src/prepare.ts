/**
 * `agentbox prepare --provider e2b` — bake the E2B base template.
 *
 * Unlike Vercel/Hetzner, E2B can build templates from a build DSL (the SDK's
 * `Template` + `Template.build`). We mirror Vercel's `prepare` shape but drive
 * the build through the SDK builder API instead of booting a sandbox + running
 * `provision.sh`:
 *
 *   1. Resolve runtime assets + fingerprint the build context. Skip-fast when
 *      an up-to-date template id is already recorded.
 *   2. Stage every resolved asset under a temp `fileContextPath` directory
 *      with predictable relative names (E2B's `template.copy(src, dest)`
 *      requires sources to be RELATIVE paths inside the context dir).
 *   3. `Template({ fileContextPath })` → `.fromBaseImage()` (E2B's default
 *      Debian 12 + node 20 + git + sudo). `.copy(rel, dest)` for each asset,
 *      `.runCmd('bash /tmp/agentbox-build-template.sh', { user: 'root' })`,
 *      `.setReadyCmd('test -x /usr/local/bin/agentbox-ctl')`.
 *   4. `Template.build(t, 'agentbox-base:<tag>', { cpuCount, memoryMB,
 *      onBuildLogs })` streams logs into the spinner; returns the BuildInfo
 *      with the template id.
 *   5. Persist `{ schema:1, base: { templateId, contextSha256, cliVersion,
 *      cliCommit, createdAt } }` to ~/.agentbox/e2b-prepared.json.
 *
 * Templates on E2B are reusable named resources addressed by id+tag. Re-running
 * with the same name reuses the existing template id (E2B's documented
 * behavior). Unlike Vercel snapshots there's no per-box eviction concern; one
 * template is reused for every create.
 *
 * vCPU / RAM are template-level on E2B — set them here so per-box `create`
 * doesn't try to override them (which E2B rejects).
 */

import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Provider } from '@agentbox/core';
import {
  claudeInstallFingerprint,
  computeContextSha256,
  readCliStamp,
  stageAllAgentStatic,
  type AgentStaticStage,
} from '@agentbox/sandbox-core';
import { ensureE2bCredentials } from './credentials.js';
import { resolveApiKey, Template } from './sdk.js';
import {
  preparedStatePath,
  readPreparedState,
  writePreparedState,
} from './prepared-state.js';
import {
  findStagedCliRuntimeRoot,
  resolveRuntimeAssets,
  type ResolvedAsset,
} from './runtime-assets.js';

export interface PrepareE2bOptions {
  name?: string;
  hostWorkspace?: string;
  /** Force re-bake even when an up-to-date template id is recorded. */
  force?: boolean;
  /**
   * Bake-time `cpu-memory` GB size (e.g. `4-8`). Wins over `cpuCount`/`memoryMB`
   * when set. A third `-disk` slot is accepted with a warning (E2B has no disk
   * knob). Resolved by the CLI from `--size` / `box.sizeE2b` / `box.size`.
   */
  size?: string;
  /** vCPUs for the baked template (default 2). E2B applies this per-sandbox at boot. */
  cpuCount?: number;
  /** Memory in MiB for the baked template (default 4096). */
  memoryMB?: number;
  /** CLI runtime tree (set by the CLI to its dist neighbor). */
  cliRuntimeRoot?: string;
  /** Repo root for the dev fallback (defaults to a cwd-walk). */
  repoRoot?: string;
  /** How build-template.sh installs Claude Code (`native` default | `npm`). */
  claudeInstall?: 'native' | 'npm';
  onLog?: (line: string) => void;
}

export interface PrepareE2bResult {
  snapshotName?: string;
}

/** Template name agentbox bakes under. E2B treats `name:tag` as a single addressable build. */
const TEMPLATE_NAME = 'agentbox-base:latest';
const DEFAULT_TAG = 'latest';

const DEFAULT_CPU = 2;
const DEFAULT_MEMORY_MB = 4096;

/**
 * Parse a `cpu-memory` GB size spec (e.g. `4-8`) into E2B's
 * `{ cpuCount, memoryMB }`. A third `-disk` slot is accepted but ignored with a
 * warning (E2B's `Template.build` has no disk knob). Returns `undefined` for an
 * empty/unset spec (caller keeps its defaults); throws on a malformed spec so
 * `prepare` surfaces it rather than silently baking the default size.
 *
 * Exported for unit tests.
 */
export function parseE2bSize(
  spec: string | undefined,
  warn?: (msg: string) => void,
): { cpuCount: number; memoryMB: number } | undefined {
  const trimmed = (spec ?? '').trim();
  if (trimmed === '') return undefined;
  const parts = trimmed.split('-');
  const bad = (): never => {
    throw new Error(
      `invalid --size '${trimmed}' for e2b: expected 'cpu-memory' GB, e.g. '4-8'.`,
    );
  };
  if (parts.length < 2 || parts.length > 3) bad();
  const nums = parts.map((p) => Number(p));
  // Every present slot must be a positive integer (rejects '4-8-', 'a-b', '0-8').
  if (nums.some((n) => !Number.isInteger(n) || n <= 0)) bad();
  if (parts.length === 3) {
    warn?.(
      `e2b: ignoring the disk slot in size '${trimmed}' — E2B templates have no disk knob; ` +
        `only cpu-memory (${String(nums[0])}-${String(nums[1])}) is applied.`,
    );
  }
  return { cpuCount: nums[0]!, memoryMB: nums[1]! * 1024 };
}

/** Normalize a parsed E2B size back to a canonical `cpu-memGB` key for the prepared state. */
function e2bSizeKey(parsed: { cpuCount: number; memoryMB: number }): string {
  return `${String(parsed.cpuCount)}-${String(parsed.memoryMB / 1024)}`;
}

export async function prepareE2b(
  opts: PrepareE2bOptions = {},
): Promise<PrepareE2bResult> {
  await ensureE2bCredentials();
  const apiKey = resolveApiKey();
  const log = opts.onLog ?? (() => {});
  const progress = (s: string) => log(`prepare-e2b: ${s}`);

  const assets = resolveRuntimeAssets({
    cliRuntimeRoot: opts.cliRuntimeRoot ?? findStagedCliRuntimeRoot(),
    repoRoot: opts.repoRoot,
  });
  const claudeInstall = opts.claudeInstall ?? 'native';
  const contextSha = claudeInstallFingerprint(
    await computeContextSha256(assets.map((a) => ({ rel: a.name, abs: a.localPath }))),
    claudeInstall,
  );

  // Bake-time size. A `--size` / `box.sizeE2b` like `4-8` overrides the default
  // cpu/memory (E2B rejects per-create resources, so it MUST be baked). The
  // normalized `cpu-memGB` key gates skip-fast so a re-sized bake rebuilds.
  const parsedSize = parseE2bSize(opts.size, (m) => log(m));
  const sizeKey = parsedSize ? e2bSizeKey(parsedSize) : undefined;

  // Skip-fast: existing template + matching fingerprint.
  //
  // Probe the persisted templateId itself, not TEMPLATE_NAME. If someone
  // (or another bake) rebuilt the alias under a different id, the name still
  // resolves but the stored id is stale and `Sandbox.create({ template: <stale id> })`
  // 404s. `Template.exists` accepts both `name:tag` and `template-id:tag`
  // forms, so we pass the exact id we'd later hand to `provision`.
  const existing = readPreparedState();
  if (!opts.force && existing.base) {
    const bakedSize = existing.base.size;
    if (existing.base.contextSha256 === contextSha && bakedSize === sizeKey) {
      const stillThere = await templateExists(existing.base.templateId, apiKey);
      if (stillThere) {
        progress(
          `template ${existing.base.templateId} already exists (fingerprint ${contextSha.slice(0, 12)} matches); skipping (pass --force to rebuild)`,
        );
        return { snapshotName: existing.base.templateId };
      }
      progress(`recorded template ${existing.base.templateId} is gone on E2B; rebuilding`);
    } else if (existing.base.contextSha256 === contextSha && bakedSize !== sizeKey) {
      progress(
        `size changed (was ${bakedSize ?? 'default'}, now ${sizeKey ?? 'default'}); rebuilding`,
      );
    } else {
      progress(
        `build context changed (was ${existing.base.contextSha256?.slice(0, 12) ?? '<none>'}, now ${contextSha.slice(0, 12)}); rebuilding`,
      );
    }
  }

  // E2B's `template.copy(src, dest)` requires `src` to be a RELATIVE path
  // inside the Template's `fileContextPath`. Stage every resolved asset into
  // a temp dir under its logical name (asset.name) so the copy chain reads
  // from a single context root.
  const contextDir = await mkdtemp(join(tmpdir(), 'agentbox-e2b-build-'));
  let agentStages: AgentStaticStage[] = [];
  try {
    progress(`staging build context at ${contextDir}`);
    await stageAssetsInto(contextDir, assets);

    // Stage the host's per-tool static config (shared sync-layer producer) and
    // copy each tarball into the build context (E2B copy sources must be
    // relative to fileContextPath).
    agentStages = await stageAllAgentStatic({ hostWorkspace: opts.hostWorkspace });
    for (const s of agentStages) for (const w of s.staged.warnings) log(w);
    const usableStages = agentStages.filter((s) => s.staged.tarballPath !== null);
    for (const s of usableStages) {
      await copyFile(s.staged.tarballPath as string, resolve(contextDir, e2bStagePaths(s.kind).contextRel));
    }

    // Build the Template via the SDK builder. fromBaseImage() starts from E2B's
    // own `e2bdev/base` (Debian 12 + node 20 + git + sudo), which halves the
    // install time vs starting from a vanilla Debian image.
    progress('assembling template build (fromBaseImage + asset copy + runCmd)');
    const template = Template({ fileContextPath: contextDir }).fromBaseImage();
    for (const a of assets) {
      progress(`  copy ${a.name} -> ${a.remotePath}`);
      template.copy(a.name, a.remotePath, {
        forceUpload: true,
        mode: a.remoteMode,
        user: 'root',
      });
    }
    template.runCmd(`AGENTBOX_CLAUDE_INSTALL=${claudeInstall} bash /tmp/agentbox-build-template.sh 2>&1`, {
      user: 'root',
    });

    // Seed the host's static agent config ON TOP of the built box (the vscode
    // user + home dirs exist only after build-template.sh). Copy each staged
    // tarball into the build, then one root pass extracts + chowns them —
    // mirrors Vercel/Hetzner/Daytona's host-static bake.
    for (const s of usableStages) {
      const { contextRel, remoteTar } = e2bStagePaths(s.kind);
      progress(`  seed ${s.kind} static -> ${s.extractDir}`);
      template.copy(contextRel, remoteTar, { forceUpload: true, mode: 0o644, user: 'root' });
    }
    if (usableStages.length > 0) {
      const extract =
        usableStages
          .map((s) => `mkdir -p ${s.extractDir} && tar -xzf ${e2bStagePaths(s.kind).remoteTar} -C ${s.extractDir} --no-same-permissions --no-same-owner -m`)
          .join(' && ') +
        ' && chown -R vscode:vscode /home/vscode/.claude /home/vscode/.codex /home/vscode/.local' +
        ' && ([ -d /home/vscode/.agents ] && chown -R vscode:vscode /home/vscode/.agents || true)' +
        ' && rm -f /tmp/agentbox-seed-*.tar.gz';
      template.runCmd(extract, { user: 'root' });
    }
    // setReadyCmd flips the builder into TemplateFinal — required for build().
    // The check passes once the script's last `install` step lands the ctl bundle.
    const finalTemplate = template.setReadyCmd(
      'test -x /usr/local/bin/agentbox-ctl',
    );

    // Parsed `--size` wins over the explicit cpuCount/memoryMB options, which
    // win over the built-in defaults.
    const cpuCount = parsedSize?.cpuCount ?? opts.cpuCount ?? DEFAULT_CPU;
    const memoryMB = parsedSize?.memoryMB ?? opts.memoryMB ?? DEFAULT_MEMORY_MB;
    progress(
      `running Template.build('${TEMPLATE_NAME}', { cpuCount: ${String(cpuCount)}, memoryMB: ${String(memoryMB)} })`,
    );
    const info = await Template.build(finalTemplate, TEMPLATE_NAME, {
      apiKey,
      cpuCount,
      memoryMB,
      onBuildLogs: (entry: LogEntryLike) => {
        // LogEntry exposes timestamp / level / message; stream the human form.
        log(`[build] ${formatBuildLog(entry)}`);
      },
    });
    progress(`template built: id=${info.templateId} build=${info.buildId} name=${info.name}`);

    // Persist. `Sandbox.create({ template })` auto-appends `:default` when no
    // tag is given (and 404s if that tag wasn't built), so we MUST store the
    // tagged form. `info.templateId` is just the raw id with no tag; use the
    // first tag we built with (`latest`) or fall back to `info.tags[0]`.
    const tag = info.tags?.[0] ?? DEFAULT_TAG;
    const cliStamp = readCliStamp();
    const taggedId = `${info.templateId}:${tag}`;
    writePreparedState({
      schema: 1,
      base: {
        templateId: taggedId,
        // info.name is the full `name:tag` pair Template.build() was called
        // with (e.g. `agentbox-base:latest`). Earlier code re-appended `:${tag}`
        // and produced `agentbox-base:latest:latest` in the status display.
        templateName: info.name,
        contextSha256: contextSha,
        ...(sizeKey ? { size: sizeKey } : {}),
        cliVersion: cliStamp.cliVersion,
        cliCommit: cliStamp.cliCommit,
        createdAt: new Date().toISOString(),
      },
    });
    progress(`wrote ${preparedStatePath()}`);

    progress(`prepare complete — base template ${taggedId}`);
    return { snapshotName: taggedId };
  } finally {
    await Promise.all(agentStages.map((s) => s.staged.cleanup())).catch(() => {
      // best-effort: staged-tarball cleanup failures are noise.
    });
    await rm(contextDir, { recursive: true, force: true }).catch(() => {
      // best-effort: temp dir cleanup failures are noise, not errors.
    });
  }
}

/**
 * Copy every asset into `contextDir` under its logical `name`. Preserves the
 * source mode on the copy (E2B's `template.copy` also accepts a `mode`
 * override, but the on-disk mode keeps the local stage representative).
 */
async function stageAssetsInto(
  contextDir: string,
  assets: ResolvedAsset[],
): Promise<void> {
  for (const a of assets) {
    const dest = resolve(contextDir, a.name);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(a.localPath, dest);
  }
}

/** E2B build paths for a staged tool (derived from its kind). E2B copy sources
 *  must be RELATIVE to the Template `fileContextPath`, so the tarball is staged
 *  into the context dir under `contextRel` then copied to `remoteTar`. */
function e2bStagePaths(kind: AgentStaticStage['kind']): { contextRel: string; remoteTar: string } {
  return {
    contextRel: `agentbox-seed-${kind}.tar.gz`,
    remoteTar: `/tmp/agentbox-seed-${kind}.tar.gz`,
  };
}

/**
 * Check if a named template is bootable on E2B. Returns true on a 'ready'
 * build, false on anything else (deleted, errored, never built). Used by the
 * skip-fast path to detect a template that was deleted out-of-band.
 */
async function templateExists(name: string, apiKey: string): Promise<boolean> {
  try {
    return await Template.exists(name, { apiKey });
  } catch {
    return false;
  }
}

/**
 * E2B's `LogEntry` shape (timestamp, level, message). We treat the SDK's
 * type loosely here so the line-stream doesn't bind us to internal class
 * shapes — only the `.toString()` plus `.message` are documented.
 */
interface LogEntryLike {
  message?: string;
  level?: string;
  timestamp?: Date;
  toString(): string;
}

function formatBuildLog(entry: LogEntryLike): string {
  // The SDK's LogEntry.toString() emits a `[level] timestamp message` form.
  // For the spinner we only want the message — and clip overly long lines.
  const raw = typeof entry.message === 'string' ? entry.message : entry.toString();
  const cleaned = raw.replace(/\r?\n+$/, '');
  return cleaned.length > 200 ? cleaned.slice(0, 200) + '…' : cleaned;
}

/** Provider-level binding used by the CLI's `prepare` command. */
export const prepareE2bProvider: NonNullable<Provider['prepare']> = (req) =>
  prepareE2b({
    name: req.name,
    hostWorkspace: req.hostWorkspace ?? process.cwd(),
    force: req.force,
    size: req.size,
    claudeInstall: req.claudeInstall,
    onLog: req.onLog,
  });
