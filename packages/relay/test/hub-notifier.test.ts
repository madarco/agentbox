import { describe, expect, it } from 'vitest';
import { HubNotifier } from '../src/hub-notifier.js';

describe('HubNotifier', () => {
  it('fans notify() out to every subscriber', () => {
    const n = new HubNotifier();
    let a = 0;
    let b = 0;
    n.subscribe(() => (a += 1));
    n.subscribe(() => (b += 1));
    n.notify();
    n.notify();
    expect(a).toBe(2);
    expect(b).toBe(2);
  });

  it('unsubscribe stops delivery', () => {
    const n = new HubNotifier();
    let calls = 0;
    const off = n.subscribe(() => (calls += 1));
    n.notify();
    off();
    n.notify();
    expect(calls).toBe(1);
  });

  it('a throwing listener does not block the others', () => {
    const n = new HubNotifier();
    let reached = 0;
    n.subscribe(() => {
      throw new Error('boom');
    });
    n.subscribe(() => (reached += 1));
    expect(() => n.notify()).not.toThrow();
    expect(reached).toBe(1);
  });
});
