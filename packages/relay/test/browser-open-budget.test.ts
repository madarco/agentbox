import { describe, expect, it } from 'vitest';
import {
  BROWSER_OPEN_BURST,
  BROWSER_OPEN_DEDUPE_MS,
  BROWSER_OPEN_SUSTAINED,
  BrowserOpenBudget,
} from '../src/browser-open-budget.js';

/**
 * The budget is what replaced the host-open confirm prompt as the rate limiter,
 * so these windows are the whole safety story: they must hold exactly.
 */
describe('BrowserOpenBudget', () => {
  function harness() {
    let now = 1_000_000;
    const budget = new BrowserOpenBudget(() => now);
    return {
      budget,
      advance: (ms: number) => {
        now += ms;
      },
      /** decide + record, as the mirror paths do on an auto-open. */
      open: (url: string, boxId = 'box1') => {
        const d = budget.decide(boxId, url, true);
        if (d.action === 'open') budget.record(boxId, url);
        return d;
      },
    };
  }

  it('auto-opens the first link', () => {
    const h = harness();
    expect(h.open('https://a.test').action).toBe('open');
  });

  it('drops a repeat of the same URL inside the dedupe window, then allows it after', () => {
    const h = harness();
    h.open('https://a.test');
    expect(h.open('https://a.test').action).toBe('drop');
    h.advance(BROWSER_OPEN_DEDUPE_MS + 1);
    expect(h.open('https://a.test').action).toBe('open');
  });

  it('a dropped duplicate consumes no budget', () => {
    const h = harness();
    h.open('https://a.test');
    h.open('https://a.test'); // drop
    h.open('https://a.test'); // drop
    // Only one open charged, so a second distinct URL still fits the burst.
    expect(h.open('https://b.test').action).toBe('open');
  });

  it('prompts past the burst limit, and opens again once the window slides', () => {
    const h = harness();
    expect(h.open('https://a.test').action).toBe('open');
    expect(h.open('https://b.test').action).toBe('open');
    expect(BROWSER_OPEN_BURST.limit).toBe(2);
    const over = h.open('https://c.test');
    expect(over.action).toBe('prompt');
    expect(over.reason).toContain('burst');
    h.advance(BROWSER_OPEN_BURST.windowMs + 1);
    expect(h.open('https://c.test').action).toBe('open');
  });

  it('prompts past the sustained limit even when the burst window is clear', () => {
    const h = harness();
    // Two per burst window, spaced out, up to the sustained limit.
    for (let i = 0; i < BROWSER_OPEN_SUSTAINED.limit; i += 1) {
      expect(h.open(`https://x${String(i)}.test`).action).toBe('open');
      if (i % 2 === 1) h.advance(BROWSER_OPEN_BURST.windowMs + 1);
    }
    h.advance(BROWSER_OPEN_BURST.windowMs + 1);
    const over = h.open('https://over.test');
    expect(over.action).toBe('prompt');
    expect(over.reason).toContain('sustained');
    // ...and it clears once the 10-minute window rolls past.
    h.advance(BROWSER_OPEN_SUSTAINED.windowMs + 1);
    expect(h.open('https://over.test').action).toBe('open');
  });

  it('always prompts in strict mode (box.autoApproveSafeHostActions false)', () => {
    const h = harness();
    const d = h.budget.decide('box1', 'https://a.test', false);
    expect(d.action).toBe('prompt');
    // ...but a duplicate is still a duplicate: dedupe wins over the prompt.
    h.budget.record('box1', 'https://a.test');
    expect(h.budget.decide('box1', 'https://a.test', false).action).toBe('drop');
  });

  it('budgets each box separately', () => {
    const h = harness();
    h.open('https://a.test', 'box1');
    h.open('https://b.test', 'box1');
    expect(h.open('https://c.test', 'box1').action).toBe('prompt');
    expect(h.open('https://c.test', 'box2').action).toBe('open');
  });

  it('forget() clears a box (destroy / unregister)', () => {
    const h = harness();
    h.open('https://a.test');
    h.budget.forget('box1');
    expect(h.open('https://a.test').action).toBe('open');
  });
});
