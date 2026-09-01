/**
 * Map Pi's pull labels to volume-style rels. Flat — Pi has one config root, so
 * a label IS its rel. See `@agentbox/agent-claude`'s `staged-items.ts` for why
 * these live with their agents rather than as a table in `sandbox-core`.
 */

import type { StagedItem } from '@agentbox/sandbox-core';

/** Pull items that are single files; everything else Pi pulls is a directory. */
const PI_FILE_ITEMS = new Set(['auth.json', 'settings.json']);

export function piStagedItems(newItems: string[]): StagedItem[] {
  return newItems.map((label) => ({
    rel: label,
    label,
    kind: PI_FILE_ITEMS.has(label) || label.endsWith('.md') ? ('file' as const) : ('dir' as const),
  }));
}
