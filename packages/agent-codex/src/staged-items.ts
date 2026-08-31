/**
 * Map codex's pull items to staged-item descriptors. See
 * `@agentbox/agent-claude`'s `staged-items.ts` for why these live with their
 * agents rather than as a three-arm table in `sandbox-core`.
 */

import type { StagedItem } from '@agentbox/sandbox-core';

/** `config.toml` / `auth.json` are files; `prompts` is a directory. */
export function codexStagedItems(newItems: string[]): StagedItem[] {
  return newItems.map((name) => ({
    rel: name,
    label: name,
    kind: name === 'prompts' ? ('dir' as const) : ('file' as const),
  }));
}
