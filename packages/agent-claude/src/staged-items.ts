/**
 * Map claude's pull result to staged-item descriptors.
 *
 * One of three `<agent>StagedItems` functions that sat together in
 * `sandbox-core/src/sync/agent-propagate.ts` — a per-agent table in a layer that
 * must not know about agents. Each knows only its own agent's pull shape, so
 * each now lives with that agent. The `StagedItem` contract and the transport
 * that consumes it stay shared.
 */

import type { PullClaudeResult, StagedItem } from '@agentbox/sandbox-core';

/** All claude items are directories; plugins live under the cache subpath. */
export function claudeStagedItems(result: PullClaudeResult): StagedItem[] {
  return result.newItems.map((it) => ({
    rel: it.category === 'plugins' ? `plugins/cache/${it.name}` : `${it.category}/${it.name}`,
    label: `${it.category}/${it.name}`,
    kind: 'dir' as const,
  }));
}
