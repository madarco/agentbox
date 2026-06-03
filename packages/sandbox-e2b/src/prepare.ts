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
 *   2. `Template().fromBaseImage()` (E2B's default — Debian 12 + node 20).
 *      `.copy(localPath, remotePath)` for each runtime asset.
 *      `.runCmd('bash /tmp/agentbox-build-template.sh 2>&1', { user: 'root' })`.
 *      `.setReadyCmd('test -x /usr/local/bin/agentbox-ctl')`.
 *   3. `Template.build(t, 'agentbox-base:<tag>', { cpuCount, memoryMB,
 *      onBuildLogs })` streams logs into the spinner; returns the BuildInfo
 *      with the template id.
 *   4. Persist `{ schema:1, base: { templateId, contextSha256, cliVersion,
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

import type { Provider } from '@agentbox/core';
import { computeContextSha256, readCliStamp } from '@agentbox/sandbox-core';
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
} from './runtime-assets.js';

export interface PrepareE2bOptions {
  name?: string;
  hostWorkspace?: string;
  /** Force re-bake even when an up-to-date template id is recorded. */
  force?: boolean;
  /** vCPUs for the baked template (default 2). E2B applies this per-sandbox at boot. */
  cpuCount?: number;
  /** Memory in MiB for the baked template (default 4096). */
  memoryMB?: number;
  /** CLI runtime tree (set by the CLI to its dist neighbor). */
  cliRuntimeRoot?: string;
  /** Repo root for the dev fallback (defaults to a cwd-walk). */
  repoRoot?: string;
  onLog?: (line: string) => void;
}

export interface PrepareE2bResult {
  snapshotName?: string;
}

/** Template name agentbox bakes under. E2B treats `name:tag` as a single addressable build. */
const TEMPLATE_NAME = 'agentbox-base:latest';

const DEFAULT_CPU = 2;
const DEFAULT_MEMORY_MB = 4096;

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
  const contextSha = await computeContextSha256(
    assets.map((a) => ({ rel: a.name, abs: a.localPath })),
  );

  // Skip-fast: existing template + matching fingerprint.
  const existing = readPreparedState();
  if (!opts.force && existing.base) {
    if (existing.base.contextSha256 === contextSha) {
      const stillThere = await templateExists(TEMPLATE_NAME, apiKey);
      if (stillThere) {
        progress(
          `template ${existing.base.templateId} already exists (fingerprint ${contextSha.slice(0, 12)} matches); skipping (pass --force to rebuild)`,
        );
        return { snapshotName: existing.base.templateId };
      }
      progress(`recorded template ${existing.base.templateId} is gone on E2B; rebuilding`);
    } else {
      progress(
        `build context changed (was ${existing.base.contextSha256?.slice(0, 12) ?? '<none>'}, now ${contextSha.slice(0, 12)}); rebuilding`,
      );
    }
  }

  // Build the Template via the SDK builder. fromBaseImage() starts from E2B's
  // own `e2bdev/base` (Debian 12 + node 20 + git + sudo), which halves the
  // install time vs starting from a vanilla Debian image.
  progress('assembling template build (fromBaseImage + asset copy + runCmd)');
  const template = Template().fromBaseImage();
  for (const a of assets) {
    progress(`  copy ${a.name} -> ${a.remotePath}`);
    template.copy(a.localPath, a.remotePath, {
      forceUpload: true,
      mode: a.remoteMode,
      user: 'root',
    });
  }
  template.runCmd('bash /tmp/agentbox-build-template.sh 2>&1', { user: 'root' });
  // setReadyCmd flips the builder into TemplateFinal — required for build().
  // The check passes once the script's last `install` step lands the ctl bundle.
  const finalTemplate = template.setReadyCmd(
    'test -x /usr/local/bin/agentbox-ctl',
  );

  const cpuCount = opts.cpuCount ?? DEFAULT_CPU;
  const memoryMB = opts.memoryMB ?? DEFAULT_MEMORY_MB;
  progress(
    `running Template.build('${TEMPLATE_NAME}', { cpuCount: ${String(cpuCount)}, memoryMB: ${String(memoryMB)} })`,
  );
  const info = await Template.build(finalTemplate, TEMPLATE_NAME, {
    apiKey,
    cpuCount,
    memoryMB,
    onBuildLogs: (entry: LogEntryLike) => {
      // LogEntry exposes timestamp / level / message; we just stream the
      // human-readable line.
      log(`[build] ${formatBuildLog(entry)}`);
    },
  });
  progress(`template built: id=${info.templateId} build=${info.buildId} name=${info.name}`);

  // Persist. `templateId` is what `Sandbox.create({ template })` accepts; we
  // also keep `templateName` for debug/inspect.
  const cliStamp = readCliStamp();
  writePreparedState({
    schema: 1,
    base: {
      templateId: info.templateId,
      templateName: info.name,
      contextSha256: contextSha,
      cliVersion: cliStamp.cliVersion,
      cliCommit: cliStamp.cliCommit,
      createdAt: new Date().toISOString(),
    },
  });
  progress(`wrote ${preparedStatePath()}`);

  progress(`prepare complete — base template ${info.templateId}`);
  return { snapshotName: info.templateId };
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
    onLog: req.onLog,
  });

