import { describe, expect, it } from 'vitest';
import { BrowserOpenBudget } from '../src/browser-open-budget.js';
import { offerBrowserOpen, type OpenLinkDeps } from '../src/open-link.js';
import { PendingPrompts, PromptSubscribers } from '../src/prompts.js';

/**
 * The whole point of the offer is WHERE a link opens. These pin the decision
 * table: a control box must never open one itself, an attached surface claims
 * it exactly once, and the laptop-with-nothing-attached path stays a direct
 * open (no round trip, no mailbox row).
 */
describe('offerBrowserOpen', () => {
  function harness(over: Partial<OpenLinkDeps> = {}) {
    const opened: string[] = [];
    const prompts = new PendingPrompts();
    const subscribers = new PromptSubscribers();
    const deps: OpenLinkDeps = {
      prompts,
      subscribers,
      boxId: 'box1',
      boxName: 'b1',
      autoApproveSafe: true,
      budget: new BrowserOpenBudget(),
      openHost: (u) => opened.push(u),
      ...over,
    };
    return { deps, prompts, subscribers, opened };
  }

  it('opens locally when nothing is attached and this relay is the human machine', async () => {
    const h = harness();
    await expect(offerBrowserOpen(h.deps, 'https://a.test')).resolves.toBe('opened-locally');
    expect(h.opened).toEqual(['https://a.test']);
    expect(h.prompts.size()).toBe(0);
  });

  it('never opens locally on a control box — it parks for the human machine', async () => {
    const h = harness({ controlPlane: true });
    const pending = offerBrowserOpen(h.deps, 'https://a.test');
    const parked = h.prompts.all()[0];
    expect(parked?.ev.kind).toBe('open-link');
    expect(parked?.ev.url).toBe('https://a.test');
    expect(parked?.ev.autoOpen).toBe(true);
    h.prompts.resolve(parked?.ev.id ?? '', 'y', false, true);
    await expect(pending).resolves.toBe('opened-by-client');
    expect(h.opened).toEqual([]);
  });

  it('a control box does not open even when the answer is a plain y', async () => {
    const h = harness({ controlPlane: true });
    const pending = offerBrowserOpen(h.deps, 'https://a.test');
    h.prompts.resolve(h.prompts.all()[0]?.ev.id ?? '', 'y');
    await expect(pending).resolves.toBe('unclaimed');
    expect(h.opened).toEqual([]);
  });

  it('offers to an attached surface instead of opening behind its back', async () => {
    const h = harness();
    h.subscribers.addListener('box1', () => {});
    const pending = offerBrowserOpen(h.deps, 'https://a.test');
    expect(h.prompts.all()).toHaveLength(1);
    expect(h.opened).toEqual([]);
    h.prompts.resolve(h.prompts.all()[0]?.ev.id ?? '', 'y', false, true);
    await expect(pending).resolves.toBe('opened-by-client');
    expect(h.opened).toEqual([]);
  });

  it('opens locally when a surface answers y without opening it itself', async () => {
    const h = harness();
    h.subscribers.addListener('box1', () => {});
    const pending = offerBrowserOpen(h.deps, 'https://a.test');
    // A client that rendered the unknown kind as a plain confirm.
    h.prompts.resolve(h.prompts.all()[0]?.ev.id ?? '', 'y');
    await expect(pending).resolves.toBe('opened-after-answer');
    expect(h.opened).toEqual(['https://a.test']);
  });

  it('only the first claim wins; a second answer is a no-op', async () => {
    const h = harness();
    h.subscribers.addListener('box1', () => {});
    const pending = offerBrowserOpen(h.deps, 'https://a.test');
    const id = h.prompts.all()[0]?.ev.id ?? '';
    expect(h.prompts.resolve(id, 'y', false, true)).toBe(true);
    expect(h.prompts.resolve(id, 'y', false, true)).toBe(false);
    await expect(pending).resolves.toBe('opened-by-client');
  });

  it('parks a link that still needs a human even with nothing streaming', async () => {
    // The tray and hub web read the mailbox over REST and are not subscribers,
    // so a strict-mode link must still be offered, not dropped.
    const h = harness({ autoApproveSafe: false });
    const pending = offerBrowserOpen(h.deps, 'https://a.test');
    const parked = h.prompts.all()[0];
    expect(parked?.ev.autoOpen).toBeUndefined();
    h.prompts.resolve(parked?.ev.id ?? '', 'n');
    await expect(pending).resolves.toBe('unclaimed');
    expect(h.opened).toEqual([]);
  });

  it('expires unclaimed without opening anything', async () => {
    const h = harness({ ttlMs: 5 });
    h.subscribers.addListener('box1', () => {});
    await expect(offerBrowserOpen(h.deps, 'https://a.test')).resolves.toBe('unclaimed');
    expect(h.opened).toEqual([]);
    expect(h.prompts.size()).toBe(0);
  });

  it('drops a duplicate link without offering or opening it', async () => {
    const h = harness();
    await expect(offerBrowserOpen(h.deps, 'https://a.test')).resolves.toBe('opened-locally');
    await expect(offerBrowserOpen(h.deps, 'https://a.test')).resolves.toBe('dropped');
    expect(h.opened).toEqual(['https://a.test']);
    expect(h.prompts.size()).toBe(0);
  });
});
