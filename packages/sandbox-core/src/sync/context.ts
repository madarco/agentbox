/**
 * `SyncContext` — the runtime values a concern needs that aren't the transport
 * or its per-call plan. Assembled once by the provider (docker/cloud) at create
 * or session-start and threaded through every concern, so concern signatures
 * stay `(ctx, transport, plan?)`.
 *
 * The interface itself is a Tier-1 contract that lives in `@agentbox/core` (so
 * the `ProviderSync` facade there can also name it); it's re-exported here so
 * existing `@agentbox/sandbox-core` importers are unchanged. The builder
 * `makeSyncContext` stays here — it defaults `hostHome` to the OS home dir.
 */

import { homedir } from 'node:os';
import type { SyncContext } from '@agentbox/core';

export type { SyncContext } from '@agentbox/core';

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
