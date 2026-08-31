/**
 * Map opencode's pull labels (`auth.json`, `config/<item>`) to volume-style
 * rels. See `@agentbox/agent-claude`'s `staged-items.ts` for why these live with
 * their agents rather than as a three-arm table in `sandbox-core`.
 */

import type { StagedItem } from '@agentbox/sandbox-core';

export function opencodeStagedItems(newItems: string[]): StagedItem[] {
  return newItems.map((label) => {
    const name = label.startsWith('config/') ? label.slice('config/'.length) : label;
    const isFile = name === 'auth.json' || name === 'opencode.json' || name === 'opencode.jsonc';
    return { rel: label, label, kind: isFile ? ('file' as const) : ('dir' as const) };
  });
}
