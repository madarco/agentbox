/**
 * `agentbox prepare --provider createos`.
 *
 * CreateOS sandboxes boot from an API-selected rootfs/template. The public
 * template build path is intentionally narrower than E2B's Dockerfile-backed
 * build context and does not currently let AgentBox copy its local runtime
 * assets into a reusable base image. Until that changes, prepare is a fast
 * validation step and provision installs the same VPS runtime assets into each
 * fresh sandbox before the shared cloud scaffold takes over.
 */

import type { PrepareOptions, PrepareResult } from '@agentbox/core';
import {
  ensureCreateOsCredentials,
  readCreateOsCredStatus,
  validateCreateOsCredentials,
} from './credentials.js';
import { detectCreateosCli } from './createos-cli.js';
import { findStagedCliRuntimeRoot, resolveRuntimeAssets } from './runtime-assets.js';

export interface PrepareCreateosOptions extends PrepareOptions {
  /** CLI runtime tree (set by the CLI to its dist neighbor). */
  cliRuntimeRoot?: string;
  /** Repo root for the dev fallback (defaults to a cwd-walk). */
  repoRoot?: string;
}

export async function prepareCreateos(
  opts: PrepareCreateosOptions = {},
): Promise<PrepareResult> {
  await ensureCreateOsCredentials();
  if (readCreateOsCredStatus().auth === 'none') {
    throw new Error('CreateOS credentials not configured. Run `agentbox createos login` or set CREATEOS_API_KEY.');
  }
  if (!(await validateCreateOsCredentials())) {
    throw new Error('CreateOS credentials could not be validated with `GET /v1/whoami`.');
  }
  if (!detectCreateosCli().installed) {
    throw new Error('CreateOS CLI not found on PATH. Install `createos` before preparing this provider.');
  }
  resolveRuntimeAssets({
    cliRuntimeRoot: opts.cliRuntimeRoot ?? findStagedCliRuntimeRoot(),
    repoRoot: opts.repoRoot,
  });
  opts.onLog?.(
    'prepare-createos: credentials and runtime assets ok; runtime installs during each CreateOS sandbox provision',
  );
  return { snapshotName: undefined };
}
