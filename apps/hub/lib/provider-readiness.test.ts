import { describe, expect, it } from 'vitest';
import { providerHasReusableBase, providerIsConfigured } from './provider-readiness';

const EMPTY = {
  hasCredentials: false,
  hasPreparedBase: false,
  remoteDockerHostCount: 0,
};

describe('provider readiness', () => {
  it('treats CreateOS credentials as sufficient without a prepared base', () => {
    expect(
      providerIsConfigured('createos', {
        ...EMPTY,
        hasCredentials: true,
      }),
    ).toBe(true);
    expect(providerHasReusableBase('createos')).toBe(false);
  });

  it('still requires prepared bases for snapshot-backed cloud providers', () => {
    expect(providerIsConfigured('e2b', EMPTY)).toBe(false);
    expect(
      providerIsConfigured('e2b', {
        ...EMPTY,
        hasPreparedBase: true,
      }),
    ).toBe(true);
    expect(providerHasReusableBase('e2b')).toBe(true);
  });
});
