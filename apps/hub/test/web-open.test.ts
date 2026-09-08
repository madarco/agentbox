import { describe, expect, it } from 'vitest';
import { webOpenTarget } from '../lib/boxes/web-open';

/**
 * Both cases below were shipped wrong once, and neither is visible in a
 * screenshot — the button looks identical either way.
 */
describe('webOpenTarget', () => {
  it('links at the hub redirect for a running box, never the recorded URL', () => {
    const t = webOpenTarget({ id: 'b1', webUrl: 'https://b1.localhost', state: 'running' });
    expect(t).toEqual({ href: '/boxes/b1/web', reason: null });
  });

  it('still opens a box whose AGENT errored — that is when you look', () => {
    // An agent error maps a live box to status 'error' while `state` stays
    // 'running'. Keying off status would send this click to a dead URL.
    const t = webOpenTarget({
      id: 'b1',
      webUrl: 'https://b1.localhost',
      state: 'running',
      status: 'error',
    });
    expect(t.href).toBe('/boxes/b1/web');
  });

  it('disables a PAUSED box, which still carries a webUrl', () => {
    // Measured: the listing fills `webUrl` from persisted endpoints whatever the
    // runtime state, so "webUrl means reachable" is false and the button would
    // stay enabled over a dead link.
    const t = webOpenTarget({ id: 'b1', webUrl: 'https://b1.localhost', state: 'paused' });
    expect(t.href).toBeNull();
    expect(t.reason).toMatch(/paused/i);
  });

  it('disables a stopped box, and says which', () => {
    const t = webOpenTarget({ id: 'b1', webUrl: 'https://b1.localhost', state: 'stopped' });
    expect(t.href).toBeNull();
    expect(t.reason).toMatch(/stopped/i);
  });

  it('says "no web service" when there is no URL at all', () => {
    expect(webOpenTarget({ id: 'b1', state: 'running' }).reason).toMatch(/no web service/i);
  });

  it('falls back to `status` when the hub sends no raw state', () => {
    // A hosted plane sends no `state`; there an agent error is indistinguishable
    // from a dead box anyway, so the normalized status is the best available.
    expect(webOpenTarget({ id: 'b1', webUrl: 'u', status: 'running' }).href).toBe('/boxes/b1/web');
    expect(webOpenTarget({ id: 'b1', webUrl: 'u', status: 'paused' }).href).toBeNull();
  });

  it('escapes an id that would otherwise break the path', () => {
    expect(webOpenTarget({ id: 'a/b', webUrl: 'u', state: 'running' }).href).toBe(
      '/boxes/a%2Fb/web',
    );
  });
});
