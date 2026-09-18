/**
 * The id a timeline row is tie-broken by. Its own file because it mocks the
 * seed: a random starting point that lands near the top of the suffix's range
 * is the only way the within-millisecond counter can wrap, and wrapping puts
 * the row written SECOND first again — the mis-ordering the counter was added
 * to fix.
 */
import { describe, expect, it, vi } from 'vitest';

// The worst seed there is: every bit set. Masked to 23 bits it leaves a full
// half of the range to count through; unmasked it wraps on the very next id.
vi.mock('node:crypto', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:crypto')>();
  return { ...orig, randomBytes: () => Buffer.from([0xff, 0xff, 0xff]) };
});

const { newTimelineEventId } = await import('../src/workspaces/timeline-store.js');

describe('newTimelineEventId', () => {
  it('counts up without wrapping from the highest seed it can draw', () => {
    const ms = 1_900_000_000_000;
    const ids = Array.from({ length: 5000 }, () => newTimelineEventId(ms));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
    // A wrapped counter also loses the fixed width that makes the sort work.
    expect(new Set(ids.map((id) => id.length)).size).toBe(1);
  });

  it('starts a new millisecond from a fresh seed, below the second half', () => {
    const id = newTimelineEventId(1_900_000_000_001);
    expect(parseInt(id.split('-')[1]!, 16)).toBeLessThan(0x800000);
  });
});
