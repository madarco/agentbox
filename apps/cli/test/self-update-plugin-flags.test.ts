import { describe, expect, it } from 'vitest';
import { postUpdateRefreshCommand } from '../src/commands/_post-update-refresh.js';
import { updateCommand } from '../src/commands/update.js';

/**
 * `self-update` shells out to `agentbox _post-update-refresh` and forwards its
 * skip flags. A flag added on only one side of that boundary fails at the worst
 * possible moment — mid-upgrade, as a commander "unknown option" that takes the
 * whole refresh down — and no other test would notice.
 */
describe('--skip-plugins spans the self-update shell-out', () => {
  const longs = (c: { options: readonly { long?: string }[] }) => c.options.map((o) => o.long);

  it('is offered by self-update', () => {
    expect(longs(updateCommand)).toContain('--skip-plugins');
  });

  it('is understood by the worker it shells out to', () => {
    expect(longs(postUpdateRefreshCommand)).toContain('--skip-plugins');
  });

  it('keeps the pre-existing --skip-skills pairing intact', () => {
    expect(longs(updateCommand)).toContain('--skip-skills');
    expect(longs(postUpdateRefreshCommand)).toContain('--skip-skills');
  });
});
