/**
 * Copy host env/config files (`.env`, `secrets.toml`, `agentbox.yaml`, …) into
 * a cloud sandbox's `/workspace` at create time. The cloud counterpart of
 * `copyHostEnvFilesToBox` in sandbox-docker — same `find` + `tar --null -T -`
 * packer on the host, swaps `docker exec tar -xf` for `backend.uploadFile` +
 * `backend.exec(tar -xf)`.
 *
 * The wizard collects `envFilesToImport` in apps/cli/src/wizard.ts (the same
 * field the Docker provider already honours). This module makes the cloud
 * provider honour it too.
 *
 * Best-effort: a scan/pack failure or empty match set logs and returns the
 * count rather than throwing — a missing optional secret mustn't abort an
 * otherwise healthy box.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { buildHostEnvFindArgs } from '@agentbox/sandbox-docker';
import type { CloudBackend, CloudHandle } from '@agentbox/core';

export interface UploadEnvFilesArgs {
  backend: CloudBackend;
  handle: CloudHandle;
  /** Absolute host workspace path the find runs against. */
  workspacePath: string;
  /** Glob patterns selected by the wizard (e.g. `.env`, `secrets.toml`). */
  files: string[];
  /** In-sandbox `/workspace` mount. Always `/workspace` today; configurable for tests. */
  workspaceDir?: string;
  onLog?: (line: string) => void;
}

export interface UploadEnvFilesResult {
  /** Number of files written into the sandbox. 0 when nothing matched. */
  copied: number;
}

const WORKSPACE_DIR_DEFAULT = '/workspace';
const REMOTE_TAR_PATH = '/tmp/agentbox-envfiles.tar';

export async function uploadEnvFiles(args: UploadEnvFilesArgs): Promise<UploadEnvFilesResult> {
  const log = args.onLog ?? (() => {});
  if (args.files.length === 0) return { copied: 0 };
  const workspaceDir = args.workspaceDir ?? WORKSPACE_DIR_DEFAULT;

  // 1. Enumerate matched files on the host with `find -print0` (NUL-delimited)
  //    using exactly the same arg builder Docker uses, so the patterns + the
  //    prune set behave identically across providers.
  const found = await execa('find', buildHostEnvFindArgs(args.files).slice(1), {
    cwd: args.workspacePath,
    reject: false,
  });
  if (found.exitCode !== 0) {
    log(`env-file scan failed: ${String(found.stderr).slice(0, 300)}`);
    return { copied: 0 };
  }
  const list = String(found.stdout)
    .split('\0')
    .filter((p) => p.length > 0);
  if (list.length === 0) return { copied: 0 };

  // 2. Pack the matched files into a tar on the host. `--null -T -` reads the
  //    file list NUL-delimited from stdin so paths with whitespace survive.
  //    We write to a tempfile (rather than streaming) because backend.uploadFile
  //    takes a local file path, not a stream.
  const stage = await mkdtemp(join(tmpdir(), 'agentbox-envfiles-'));
  const localTar = join(stage, 'envfiles.tar');
  try {
    const packed = await execa(
      'tar',
      ['-C', args.workspacePath, '--null', '-T', '-', '-cf', localTar],
      { input: list.join('\0'), reject: false },
    );
    if (packed.exitCode !== 0) {
      log(`env-file tar pack failed: ${String(packed.stderr).slice(0, 300)}`);
      return { copied: 0 };
    }
    // Ensure the file exists even when tar packed nothing useful (best-effort).
    await writeFile(join(stage, '.marker'), '').catch(() => {});

    // 3. Upload the tar into the sandbox + extract under /workspace. Same
    //    `--no-same-*` + `-m` flags we use for the credential extracts: future-
    //    proofs against ever putting /workspace on Daytona's FUSE volume tier
    //    (chmod/utime would otherwise EPERM) and is harmless on regular disk.
    //    `rm -f` cleans the staging tar so the sandbox /tmp doesn't accumulate
    //    leftovers across multiple creates against the same handle (cheap).
    await args.backend.uploadFile(args.handle, localTar, REMOTE_TAR_PATH);
    const extract = await args.backend.exec(
      args.handle,
      `tar -xf ${REMOTE_TAR_PATH} -C ${workspaceDir} --no-same-permissions --no-same-owner -m && rm -f ${REMOTE_TAR_PATH}`,
    );
    if (extract.exitCode !== 0) {
      log(
        `env-file extract failed (exit ${String(extract.exitCode)}); ` +
          `stdout: ${extract.stdout.slice(-200)} stderr: ${extract.stderr.slice(-200)}`,
      );
      return { copied: 0 };
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { copied: list.length };
}
