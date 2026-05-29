import { describe, expect, it } from 'vitest';
import { computeLayout, SIDEBAR_WIDTH } from '../src/dashboard/layout.js';

describe('computeLayout', () => {
  it('splits sidebar + separator + right pane + status row', () => {
    const l = computeLayout(120, 40);
    expect(l.sidebar).toEqual({ x: 0, y: 0, w: SIDEBAR_WIDTH, h: 39 });
    expect(l.sepX).toBe(SIDEBAR_WIDTH);
    expect(l.right.x).toBe(SIDEBAR_WIDTH + 1);
    expect(l.right.w).toBe(120 - SIDEBAR_WIDTH - 1);
    expect(l.right.h).toBe(39);
    expect(l.statusY).toBe(39);
    expect(l.tooSmall).toBe(false);
  });

  it('flags tooSmall when the right pane cannot fit', () => {
    // Sidebar shrinks to protect a 20-col right pane; only too small below ~21.
    expect(computeLayout(40, 40).tooSmall).toBe(false);
    expect(computeLayout(20, 40).tooSmall).toBe(true);
    expect(computeLayout(120, 4).tooSmall).toBe(true);
  });

  it('shrinks the sidebar before going negative', () => {
    const l = computeLayout(45, 20);
    expect(l.sidebar.w).toBeLessThan(SIDEBAR_WIDTH);
    expect(l.right.w).toBeGreaterThanOrEqual(0);
  });

  it('reserves a 3-row alert band when requested', () => {
    const l = computeLayout(120, 40, 3);
    expect(l.alertH).toBe(3);
    // alertY is the band's top row; right.h shrinks by the band height.
    expect(l.alertY).toBe(36);
    expect(l.right.h).toBe(36);
    expect(l.sidebar.h).toBe(36);
    // The footer row itself is unchanged.
    expect(l.statusY).toBe(39);
  });

  it('omits the alert band when no height is requested', () => {
    const l = computeLayout(120, 40);
    expect(l.alertH).toBe(0);
    expect(l.alertY).toBe(l.statusY);
    expect(l.right.h).toBe(39);
  });

  it('drops the band to 0 when the terminal cannot host it (min-size fallback)', () => {
    // statusY = 5, MIN_RIGHT_H = 4 → reserving 3 would leave paneH = 2 < 4,
    // so the band collapses and the right pane keeps its full height.
    const l = computeLayout(120, 6, 3);
    expect(l.alertH).toBe(0);
    expect(l.right.h).toBe(5);
  });
});
