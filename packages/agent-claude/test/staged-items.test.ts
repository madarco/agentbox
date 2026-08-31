import { describe, expect, it } from 'vitest';
import { claudeStagedItems } from '../src/staged-items.js';

/**
 * Moved with the mapper out of `sandbox-core/test/agent-propagate.test.ts`,
 * where the three agents' mappers were tested side by side.
 */
describe('claudeStagedItems', () => {
  it('uses category rels, with plugins under plugins/cache', () => {
    expect(
      claudeStagedItems({
        newItems: [
          { category: 'skills', name: 'foo' },
          { category: 'plugins', name: 'mkt/plug' },
        ],
        mergedRegistries: [],
      }),
    ).toEqual([
      { rel: 'skills/foo', label: 'skills/foo', kind: 'dir' },
      { rel: 'plugins/cache/mkt/plug', label: 'plugins/mkt/plug', kind: 'dir' },
    ]);
  });

  it('maps every claude item as a dir', () => {
    const items = claudeStagedItems({
      newItems: [{ category: 'agents', name: 'a' }],
      mergedRegistries: [],
    });
    expect(items.every((i) => i.kind === 'dir')).toBe(true);
  });
});
