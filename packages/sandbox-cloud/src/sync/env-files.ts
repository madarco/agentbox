/**
 * Copy host env/config files (`.env`, `secrets.toml`, `agentbox.yaml`, …) into
 * a cloud sandbox's `/workspace` at create time. Thin wrapper over the shared
 * env concern (`@agentbox/sandbox-core`'s sync/concerns/env): same host-side
 * `find` + `tar --null -T -` pack, with the cloud transport's `applyTarball`
 * (`uploadFile` + `backend.exec(tar -xf … --no-same-* -m)`) doing the extract.
 *
 * The wizard collects `envFilesToImport` (apps/cli/src/wizard.ts); this makes
 * the cloud provider honour it, exactly like the docker provider.
 */

import { makeSyncContext, pushEnvFiles } from '@agentbox/sandbox-core';
import type { CloudBackend, CloudHandle } from '@agentbox/core';
import { createCloudSyncTransport } from './sync-transport.js';

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

export async function uploadEnvFiles(args: UploadEnvFilesArgs): Promise<UploadEnvFilesResult> {
  if (args.files.length === 0) return { copied: 0 };
  const ctx = makeSyncContext({
    boxName: '',
    boxId: '',
    provider: 'cloud',
    hostWorkspace: args.workspacePath,
    boxWorkspace: args.workspaceDir ?? '/workspace',
    onLog: args.onLog,
  });
  const transport = createCloudSyncTransport({ backend: args.backend, handle: args.handle });
  return pushEnvFiles(ctx, transport, args.files);
}
