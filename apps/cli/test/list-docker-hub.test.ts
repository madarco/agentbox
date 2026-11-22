import { describe, expect, it } from 'vitest';
import { listingOwnsLocalDocker } from '../src/commands/list.js';

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
