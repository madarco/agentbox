import { describe, expect, it } from 'vitest';
import { listingOwnsLocalDocker, mutedUnderControlBox } from '../src/commands/list.js';

/**
 * `ls` tags docker boxes "inactive" only when they are THIS machine's own
 * (a local docker box left under a control box). A docker:hub box listed from
 * the control box runs on the control box's engine and is hub-driven: another
 * PC used to see it as "remote-docker (inactive)".
 */
describe('listingOwnsLocalDocker', () => {
  const target = (mode: 'local' | 'remote') => ({ target: { url: 'u', apiKey: 'k', mode } });
  it('a listing from a remote control box never owns local docker', () => {
    expect(listingOwnsLocalDocker(target('remote'), true)).toBe(false);
  });
  it("a listing from this machine's own hub does", () => {
    expect(listingOwnsLocalDocker(target('local'), false)).toBe(true);
    expect(listingOwnsLocalDocker(target('local'), true)).toBe(true);
  });
  it('a cached listing came from the control box when one is configured', () => {
    expect(listingOwnsLocalDocker({}, true)).toBe(false);
    expect(listingOwnsLocalDocker({}, false)).toBe(true);
  });
});

describe('mutedUnderControlBox', () => {
  it('plain docker is always a laptop-local engine, even in the control box listing', () => {
    expect(mutedUnderControlBox('docker', false)).toBe(true);
    expect(mutedUnderControlBox('docker', true)).toBe(true);
  });
  it('remote-docker (docker:hub) is live in the control box listing, a leftover in a local one', () => {
    expect(mutedUnderControlBox('remote-docker', false)).toBe(false);
    expect(mutedUnderControlBox('remote-docker', true)).toBe(true);
  });
  it('never mutes a cloud box', () => {
    expect(mutedUnderControlBox('hetzner', true)).toBe(false);
  });
});
