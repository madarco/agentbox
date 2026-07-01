/**
 * `SyncContext` — the runtime values a concern needs that aren't the transport
 * or its per-call plan. Assembled once by the provider (docker/cloud) at create
 * or session-start and threaded through every concern, so concern signatures
 * stay `(ctx, transport, plan?)`.
 */

import { homedir } from 'node:os';

export interface SyncContext {
  /** Friendly box name (`agentbox/<name>` branch, tmux session, logs). */
  boxName: string;
  /** Stable box id. */
  boxId: string;
  /** Which provider assembled this context. */
  provider: 'docker' | 'cloud';
  /** Absolute host workspace dir mounted at `boxWorkspace`. */
  hostWorkspace: string;
  /** Project root (nearest `agentbox.yaml` ancestor, else `hostWorkspace`). */
  projectRoot: string;
  /** In-box workspace mount. Always `/workspace` today; overridable for tests. */
  boxWorkspace: string;
  /** Host home dir (source of `~/.claude` etc.). Overridable for tests. */
  hostHome: string;
  onLog: (line: string) => void;
}

export interface SyncContextInit {
  boxName: string;
  boxId: string;
  provider: 'docker' | 'cloud';
  hostWorkspace: string;
  projectRoot?: string;
  boxWorkspace?: string;
  hostHome?: string;
  onLog?: (line: string) => void;
}

/** Build a `SyncContext` with the conventional defaults filled in. */
export function makeSyncContext(init: SyncContextInit): SyncContext {
  return {
    boxName: init.boxName,
    boxId: init.boxId,
    provider: init.provider,
    hostWorkspace: init.hostWorkspace,
    projectRoot: init.projectRoot ?? init.hostWorkspace,
    boxWorkspace: init.boxWorkspace ?? '/workspace',
    hostHome: init.hostHome ?? homedir(),
    onLog: init.onLog ?? (() => {}),
  };
}
