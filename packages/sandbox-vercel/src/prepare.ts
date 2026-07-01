/**
 * `agentbox prepare --provider vercel` — bake the per-team Vercel base
 * snapshot. Vercel can't build an image from a Dockerfile, so (like hetzner)
 * we boot a fresh sandbox, run an installer, and snapshot the result. That
 * snapshot id is what every per-box `create` boots from.
 *
 * Flow:
 *   1. Resolve runtime assets + fingerprint the build context. Skip the bake
 *      when an up-to-date base snapshot already exists (unless --force).
 *   2. `Sandbox.create({ runtime: 'node24', persistent: false })` — fresh AL2023.
 *   3. `writeFiles` the assets (ctl bundle, helpers, baked configs, provision.sh).
 *   4. Run provision.sh as root, streaming output to the prepare log.
 *   5. Stage host agent static config (claude/codex/opencode) into the snapshot.
 *   6. `sandbox.snapshot({ expiration: 0 })` → the never-expiring base snapshot.
 *   7. Persist the snapshot id into ~/.agentbox/vercel-prepared.json.
 *   8. Delete the builder sandbox.
 *
 * Step 8 is safe: a Vercel snapshot is an independent, id-addressed resource
 * that survives its source sandbox's deletion (verified live — snapshot stays
 * `status: 'created'` and boots a fresh sandbox after the builder is deleted).
 * We delete it best-effort *after* the snapshot id is persisted, so a delete
 * failure only leaves a lingering sandbox for Vercel's reaper, never a broken
 * bake.
 */

import { readFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import type { Provider } from '@agentbox/core';
import { claudeInstallFingerprint, computeContextSha256, readCliStamp } from '@agentbox/sandbox-core';
import {
  stageClaudeStaticForUpload,
  stageCodexStaticForUpload,
  stageOpencodeStaticForUpload,
  type StageResult,
} from '@agentbox/sandbox-cloud';
import { ensureVercelCredentials } from './credentials.js';
import {
  ensureFreshCredentials,
  resolveCredentials,
  Sandbox,
  Snapshot,
  type SandboxType,
} from './sdk.js';
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

export interface PrepareVercelOptions {
  name?: string;
  hostWorkspace?: string;
  /** Force re-bake even when an up-to-date base snapshot is recorded. */
  force?: boolean;
  /** vCPUs for the builder sandbox (default 4 for a fast bake). */
  vcpus?: number;
  /** CLI runtime tree (set by the CLI to its dist neighbor). */
  cliRuntimeRoot?: string;
  /** Repo root for the dev fallback (defaults to a cwd-walk). */
  repoRoot?: string;
  /** How provision.sh installs Claude Code (`native` default | `npm`). */
  claudeInstall?: 'native' | 'npm';
  onLog?: (line: string) => void;
}

export interface PrepareVercelResult {
  snapshotName?: string;
}

const BUILDER_TIMEOUT_MS = 25 * 60_000;
const SHELL = '/bin/bash';

export async function prepareVercel(
  opts: PrepareVercelOptions = {},
): Promise<PrepareVercelResult> {
  await ensureVercelCredentials();
  await ensureFreshCredentials();
  const creds = resolveCredentials();
  const log = opts.onLog ?? (() => {});
  const progress = (s: string) => log(`prepare-vercel: ${s}`);

  const assets = resolveRuntimeAssets({
    cliRuntimeRoot: opts.cliRuntimeRoot ?? findStagedCliRuntimeRoot(),
    repoRoot: opts.repoRoot,
  });
  const claudeInstall = opts.claudeInstall ?? 'native';
  const contextSha = claudeInstallFingerprint(
    await computeContextSha256(assets.map((a) => ({ rel: a.name, abs: a.localPath }))),
    claudeInstall,
  );

  // Skip-fast: existing base snapshot still on Vercel + matching fingerprint.
  const existing = readPreparedState();
  if (!opts.force && existing.base) {
    const stillThere = await snapshotExists(existing.base.snapshotId, creds);
    if (stillThere && existing.base.contextSha256 === contextSha) {
      progress(
        `base snapshot ${existing.base.snapshotId} already exists (fingerprint ${contextSha.slice(0, 12)} matches); skipping (pass --force to rebuild)`,
      );
      return { snapshotName: existing.base.snapshotId };
    }
    if (!stillThere) {
      progress(`recorded base snapshot ${existing.base.snapshotId} is gone on Vercel; rebuilding`);
    } else {
      progress(
        `build context changed (was ${existing.base.contextSha256?.slice(0, 12) ?? '<none>'}, now ${contextSha.slice(0, 12)}); rebuilding`,
      );
    }
  }

  progress(`creating builder sandbox (node24, ${String(opts.vcpus ?? 4)} vcpus)`);
  const sb = await Sandbox.create({
    runtime: 'node24',
    resources: { vcpus: opts.vcpus ?? 4 },
    timeout: BUILDER_TIMEOUT_MS,
    tags: { agentbox: 'true', 'agentbox.role': 'prepare' },
    persistent: false,
    ...creds,
  });
  progress(`builder sandbox ${sb.name} up`);

  // 3. Upload assets.
  progress(`uploading ${String(assets.length)} runtime asset(s)`);
  await sb.writeFiles(
    await Promise.all(
      assets.map(async (a: ResolvedAsset) => ({
        path: a.remotePath,
        content: await readFile(a.localPath),
        mode: a.remoteMode,
      })),
    ),
  );

  // 4. Run provision.sh as root, streaming output.
  progress('running provision.sh (this takes a few minutes)');
  const install = await sb.runCommand({
    cmd: SHELL,
    args: ['-lc', `AGENTBOX_CLAUDE_INSTALL=${claudeInstall} bash /tmp/agentbox-provision.sh 2>&1`],
    sudo: true,
    stdout: lineSink((l) => log(`[provision] ${l}`)),
    stderr: lineSink((l) => log(`[provision] ${l}`)),
  });
  if (install.exitCode !== 0) {
    throw new Error(`provision.sh failed on the builder sandbox (exit ${String(install.exitCode)})`);
  }
  progress('provision.sh complete');

  // 5. Stage host agent static config into the snapshot (best-effort).
  await stageAgentConfig(sb, opts.hostWorkspace, log);

  // 6. Snapshot (never expires). NOTE: this stops the builder sandbox.
  progress('creating base snapshot (expiration: never)');
  const snap = await sb.snapshot({ expiration: 0 });
  progress(`snapshot created: ${snap.snapshotId}`);

  // 7. Persist.
  const cliStamp = readCliStamp();
  writePreparedState({
    schema: 1,
    base: {
      snapshotId: snap.snapshotId,
      contextSha256: contextSha,
      cliVersion: cliStamp.cliVersion,
      cliCommit: cliStamp.cliCommit,
      createdAt: new Date().toISOString(),
    },
  });
  progress(`wrote ${preparedStatePath()}`);

  // 8. Delete the builder. The snapshot is an independent resource that
  // survives this (verified live), and its id is already persisted above, so
  // this is best-effort: a failure just leaves the sandbox for Vercel's reaper.
  progress('deleting builder sandbox');
  try {
    await sb.delete();
    progress('builder sandbox deleted');
  } catch (err) {
    progress(
      `builder delete failed (left for Vercel reaper): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  progress(`prepare complete — base snapshot ${snap.snapshotId}`);
  return { snapshotName: snap.snapshotId };
}

async function snapshotExists(
  snapshotId: string,
  creds: Partial<{ token: string; teamId: string; projectId: string }>,
): Promise<boolean> {
  try {
    const snap = await Snapshot.get({ snapshotId, ...creds });
    // `Snapshot.get` resolves even for a deleted/failed snapshot (status field),
    // so a bare "didn't throw" wrongly skip-passes a tombstone. Only a 'created'
    // snapshot is bootable — anything else means rebuild.
    return snap.status === 'created';
  } catch {
    return false;
  }
}

async function stageAgentConfig(
  sb: SandboxType,
  hostWorkspace: string | undefined,
  log: (line: string) => void,
): Promise<void> {
  const progress = (s: string) => log(`prepare-vercel: ${s}`);
  progress('staging host agent static config');
  const stagings: Array<{ kind: 'claude' | 'codex' | 'opencode'; tar: StageResult; dest: string }> = [];
  try {
    const claudeTar = await stageClaudeStaticForUpload({ hostWorkspace });
    for (const w of claudeTar.warnings) progress(w);
    if (claudeTar.tarballPath) stagings.push({ kind: 'claude', tar: claudeTar, dest: '/home/vscode/.claude' });
    else await claudeTar.cleanup();

    const codexTar = await stageCodexStaticForUpload();
    for (const w of codexTar.warnings) progress(w);
    if (codexTar.tarballPath) stagings.push({ kind: 'codex', tar: codexTar, dest: '/home/vscode/.codex' });
    else await codexTar.cleanup();

    const opencodeTar = await stageOpencodeStaticForUpload();
    for (const w of opencodeTar.warnings) progress(w);
    if (opencodeTar.tarballPath) stagings.push({ kind: 'opencode', tar: opencodeTar, dest: '/home/vscode/.local/share/opencode' });
    else await opencodeTar.cleanup();

    for (const s of stagings) {
      const remote = `/tmp/agentbox-${s.kind}-static.tar.gz`;
      progress(`uploading ${s.kind} static config`);
      await sb.writeFiles([{ path: remote, content: await readFile(s.tar.tarballPath as string) }]);
      // Extract as vscode so files land owned by the box user. The dest dir
      // already exists (provision.sh's credential-pivot step) — extract into it.
      const extract =
        `sudo -u vscode mkdir -p ${s.dest} && ` +
        `sudo -u vscode tar -xzf ${remote} -C ${s.dest} --no-same-permissions --no-same-owner -m && ` +
        `rm -f ${remote}`;
      const r = await sb.runCommand({ cmd: SHELL, args: ['-lc', extract], sudo: true });
      if (r.exitCode !== 0) {
        progress(`WARN: ${s.kind} static extract failed (exit ${String(r.exitCode)}) — continuing`);
      } else {
        progress(`baked ${s.kind} static config into snapshot`);
      }
    }
  } finally {
    for (const s of stagings) await s.tar.cleanup();
  }
}

/**
 * Adapt a line-callback to the `Writable` the SDK's `runCommand` streams into.
 * Buffers partial lines so each `onLine` gets a complete line.
 */
function lineSink(onLine: (line: string) => void): Writable {
  let buf = '';
  return new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      cb();
    },
    final(cb: () => void) {
      if (buf.length > 0) onLine(buf);
      cb();
    },
  });
}

/** Provider-level binding used by the CLI's `prepare` command. */
export const prepareVercelProvider: NonNullable<Provider['prepare']> = (req) =>
  prepareVercel({
    name: req.name,
    hostWorkspace: req.hostWorkspace ?? process.cwd(),
    force: req.force,
    claudeInstall: req.claudeInstall,
    onLog: req.onLog,
  });
