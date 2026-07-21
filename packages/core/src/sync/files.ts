/**
 * Pure download / file-transfer decisions, co-located here so *all* sync
 * decision logic is discoverable under `core/src/sync/` — even though the two
 * download handlers keep genuinely divergent transports (docker re-shells the
 * host CLI; cloud calls `pullCloudDirContents`, workspace-only). We do NOT
 * force-unify the transport; only these shared, pure decisions live here.
 *
 * No fs/exec beyond `node:path`/`node:os` string helpers.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** The `download.<kind>` variants an in-box agent can request. */
export type DownloadKind = 'workspace' | 'env' | 'config' | 'claude';

/**
 * Parse the `download.<kind>` RPC method into its kind, defaulting a missing
 * suffix to 'workspace'. Duplicated inline at the docker (`server.ts`) and
 * cloud (`host-actions.ts`) download entry points.
 */
export function parseDownloadKind(method: string): DownloadKind {
  return (method.split('.')[1] ?? 'workspace') as DownloadKind;
}

/**
 * Resolve a host path supplied by an in-box agent to an absolute host path.
 * Absolute paths pass through; a leading `~`/`~/` expands against the host
 * home; anything else is relative to the box's host `workspacePath` (NOT the
 * relay daemon's CWD). When `workspacePath` is unknown, relative paths fall
 * back to `path.resolve` (process CWD) — same as the old behaviour.
 */
export function resolveHostPath(workspacePath: string | undefined, hostPath: string): string {
  if (isAbsolute(hostPath)) return hostPath;
  if (hostPath === '~') return homedir();
  if (hostPath.startsWith('~/')) return join(homedir(), hostPath.slice(2));
  return workspacePath ? resolve(workspacePath, hostPath) : resolve(hostPath);
}
