import { describe, expect, it } from 'vitest';
import { resolveOpencodeTeleport } from '../src/session-teleport/opencode.js';
import { TeleportError } from '../src/session-teleport/types.js';

describe('resolveOpencodeTeleport', () => {
  it('always throws TeleportError in v1', () => {
    expect(() => resolveOpencodeTeleport()).toThrow(TeleportError);
  });

  it('mentions opencode.db in the error message', () => {
    try {
      resolveOpencodeTeleport();
    } catch (err) {
      expect((err as Error).message).toContain('opencode.db');
      return;
    }
    throw new Error('expected resolveOpencodeTeleport to throw');
  });
});
