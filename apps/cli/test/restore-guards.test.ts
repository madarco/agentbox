/**
 * The three refusals that stand between `--restore` and a destroyed bot.
 *
 * All three were found by review rather than by a failing run, and each one
 * fails by doing something plausible: resuming the box you named, restoring a
 * workspace-only bundle as though it carried an identity, or writing a backup
 * over a box that is already running on that directory. They are pure functions
 * precisely so they can be asserted without provisioning anything.
 */

import { describe, expect, it } from 'vitest';
import type { BotBundle } from '@agentbox/sandbox-core';
import {
  boxRefWithRestoreRefusal,
  existingBoxRefusal,
  restoreScope,
} from '../src/commands/_restore.js';

function bundle(over: Partial<BotBundle> = {}): BotBundle {
  return {
    dir: '/p/.agentbox/bots/ada/2026-09-07T14-03-11Z',
    bot: 'ada',
    stamp: '2026-09-07T14-03-11Z',
    manifest: {
      version: 1,
      stamp: '2026-09-07T14-03-11Z',
      bot: 'ada',
      boxId: 'b0dc0ffee',
      boxName: 'ada',
      provider: 'docker',
      state: true,
    },
    workspaceDir: '/p/.agentbox/bots/ada/2026-09-07T14-03-11Z/workspace',
    stateDir: '/p/.agentbox/bots/ada/2026-09-07T14-03-11Z/state',
    ...over,
  };
}

describe('restoreScope', () => {
  it('reports workspace-only for a bundle that captured no state', () => {
    // The service command must SKIP the state half here, not throw: the box has
    // already been created by the time this is known, and failing would leave a
    // working box behind a failed command.
    expect(restoreScope(bundle({ stateDir: undefined }))).toBe('workspace');
  });

  it('reports both halves when the state dir is there', () => {
    expect(restoreScope(bundle())).toBe('workspace+state');
  });
});

describe('boxRefWithRestoreRefusal', () => {
  it('refuses a positional box ref, naming it', () => {
    // `agentbox <agent> foo --restore ada` would resume `foo` and then write
    // ada's identity over it — the create-or-resume path meeting a restore.
    const msg = boxRefWithRestoreRefusal('foo');
    expect(msg).toContain('"foo"');
    expect(msg).toMatch(/always creates a new box/);
  });

  it('allows the ref-less form', () => {
    expect(boxRefWithRestoreRefusal(undefined)).toBeNull();
  });
});

describe('existingBoxRefusal', () => {
  it('refuses when a box already runs on the restore directory', () => {
    const msg = existingBoxRefusal({ name: 'ada' }, '/p/.agentbox/bots/ada/workspace');
    expect(msg).toContain('ada');
    expect(msg).toContain('/p/.agentbox/bots/ada/workspace');
    expect(msg).toMatch(/--into/);
  });

  it('allows an empty directory, whether the lookup returned null or undefined', () => {
    // `findExistingBox` answers `null`; a caller with no lookup at all passes
    // `undefined`. Both mean "nothing in the way".
    expect(existingBoxRefusal(null, '/p')).toBeNull();
    expect(existingBoxRefusal(undefined, '/p')).toBeNull();
  });
});
