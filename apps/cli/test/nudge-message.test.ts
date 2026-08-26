import { describe, expect, it } from 'vitest';
import { nudgeMessage } from '../src/lib/update-check.js';
import type { UpdateState } from '../src/lib/update-state.js';

const state = (npmLatest: string): UpdateState => ({
  version: 1,
  remoteCheck: { checkedAt: new Date().toISOString(), npmLatest },
});

describe('nudgeMessage', () => {
  it('nudges a stable user toward a newer release', () => {
    expect(nudgeMessage(state('0.28.0'), 'npm', '0.27.0')).toContain('a newer agentbox (0.28.0)');
  });

  it('stays quiet when already current', () => {
    expect(nudgeMessage(state('0.27.0'), 'npm', '0.27.0')).toBeNull();
  });

  it('nudges a nightly user toward a newer nightly', () => {
    const msg = nudgeMessage(state('0.28.0-nightly.6'), 'npm', '0.28.0-nightly.5');
    expect(msg).toContain('0.28.0-nightly.6');
    // Nightly → nightly is not a crossover, so no stable-release hint.
    expect(msg).not.toContain('stable release');
  });

  it('labels the crossover so a stable version does not read as a downgrade', () => {
    // 0.28.0 > 0.28.0-nightly.5 by semver, but the bare number looks smaller.
    const msg = nudgeMessage(state('0.28.0'), 'npm', '0.28.0-nightly.5');
    expect(msg).toContain('0.28.0, the stable release');
  });

  it('never nudges a dev build or a non-global install', () => {
    expect(nudgeMessage(state('0.28.0'), 'npm', '0.0.0-dev')).toBeNull();
    expect(nudgeMessage(state('0.28.0'), 'npx', '0.27.0')).toBeNull();
    expect(nudgeMessage(state('0.28.0'), 'direct', '0.27.0')).toBeNull();
  });
});
