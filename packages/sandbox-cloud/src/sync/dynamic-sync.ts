/**
 * Per-box, incremental seed of Claude Code's dynamic config (global
 * `~/.claude/workflows/` + the project's `memory/`) into a cloud sandbox.
 *
 * The static config (plugins/skills/settings) is baked into the prepare-time
 * snapshot; workflows + memory change between runs, so we ship them on every
 * create — like credentials, but diffed per-file so re-creates carry only what
 * changed. The box records what it holds in a manifest at
 * {@link BOX_DYNAMIC_SYNC_MANIFEST}; because that file lives on the box
 * filesystem it rides along in every checkpoint, so a checkpoint boot only
 * syncs files changed on the host since the snapshot.
 *
 * Transport is the credential pattern — `backend.uploadFile` + `backend.exec`
 * (tar over the SDK / scp), no rsync — so it works on daytona, hetzner, and
 * vercel alike. `backend.exec` runs as `vscode` on all three, so extraction
 * into the vscode-owned home needs no chown.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BOX_DYNAMIC_SYNC_MANIFEST,
  BOX_MEMORY_DIR,
  BOX_WORKFLOWS_DIR,
  buildHostSyncManifest,
  computeSyncDelta,
  stageDynamicSyncTarball,
  type DynamicSyncManifest,
} from '@agentbox/sandbox-core';
import type { CloudBackend, CloudHandle } from '@agentbox/core';

export interface SeedDynamicConfigOptions {
  /** Host-absolute workspace path (locates the project's memory dir). */
  workspacePath: string;
  onLog?: (line: string) => void;
}

/** Single-quote a path for safe interpolation into the extract shell command. */
function sq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

const REMOTE_TAR = '/tmp/agentbox-dynsync.tar.gz';
const BOX_STAGE = '/tmp/agentbox-dynsync-stage';

/**
 * Diff the host's workflows + memory against the box's manifest and upload only
 * the delta. Best-effort: never throws into box creation. Runs on both fresh
 * and checkpoint boots — the manifest diff makes it a no-op when nothing
 * changed.
 */
export async function seedDynamicConfig(
  backend: CloudBackend,
  handle: CloudHandle,
  opts: SeedDynamicConfigOptions,
): Promise<void> {
  const log = opts.onLog ?? (() => {});

  try {
    // 1. Read the manifest the box already carries (absent on a fresh box).
    let boxManifest: DynamicSyncManifest | null = null;
    try {
      const res = await backend.exec(handle, `cat ${BOX_DYNAMIC_SYNC_MANIFEST} 2>/dev/null || true`);
      const out = res.stdout.trim();
      if (res.exitCode === 0 && out.length > 0) {
        boxManifest = JSON.parse(out) as DynamicSyncManifest;
      }
    } catch {
      boxManifest = null; // treat unreadable/corrupt manifest as fresh
    }

    // 2. Hash the host sets, 3. diff.
    const host = await buildHostSyncManifest(opts.workspacePath);
    const delta = computeSyncDelta(host, boxManifest);
    if (delta.uploads.length === 0 && delta.deletions.length === 0) {
      log('claude workflows + memory already up to date in box');
      return;
    }
    delta.nextManifest.syncedAt = new Date().toISOString();

    // 4. Stage the changed files + the manifest.
    const staged = await stageDynamicSyncTarball(delta.uploads);
    const manifestDir = await mkdtemp(join(tmpdir(), 'agentbox-dynsync-manifest-'));
    const manifestTmp = join(manifestDir, 'dynamic-sync.json');
    await writeFile(manifestTmp, JSON.stringify(delta.nextManifest, null, 2));

    try {
      const steps: string[] = [
        'set -e',
        `mkdir -p /home/vscode/.agentbox ${BOX_WORKFLOWS_DIR} ${BOX_MEMORY_DIR}`,
      ];
      if (staged.tarballPath) {
        await backend.uploadFile(handle, staged.tarballPath, REMOTE_TAR);
        steps.push(
          `rm -rf ${BOX_STAGE}`,
          `mkdir -p ${BOX_STAGE}`,
          `tar -xzf ${REMOTE_TAR} -C ${BOX_STAGE}`,
          `if [ -d ${BOX_STAGE}/workflows ]; then cp -a ${BOX_STAGE}/workflows/. ${BOX_WORKFLOWS_DIR}/; fi`,
          `if [ -d ${BOX_STAGE}/memory ]; then cp -a ${BOX_STAGE}/memory/. ${BOX_MEMORY_DIR}/; fi`,
          `rm -rf ${BOX_STAGE} ${REMOTE_TAR}`,
        );
      }
      for (const d of delta.deletions) {
        steps.push(`rm -f ${sq(d.dst)}`);
      }
      const res = await backend.exec(handle, steps.join('; '));
      if (res.exitCode !== 0) {
        log(
          `dynamic config seed failed (exit ${String(res.exitCode)}): ` +
            `${res.stderr.slice(-200)}`,
        );
        return;
      }

      // 5. Record the new manifest last — a failed extract must not record
      //    state the box never reached.
      await backend.uploadFile(handle, manifestTmp, BOX_DYNAMIC_SYNC_MANIFEST);
      log(
        `seeded claude workflows + memory: ${String(delta.uploads.length)} file(s) updated, ` +
          `${String(delta.deletions.length)} removed`,
      );
    } finally {
      await staged.cleanup();
      await rm(dirname(manifestTmp), { recursive: true, force: true });
    }
  } catch (err) {
    log(
      `claude workflows + memory seed skipped (non-fatal): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
