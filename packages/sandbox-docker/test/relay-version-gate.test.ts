import { describe, expect, it } from 'vitest';
import { shouldReclaimForVersion } from '../src/relay.js';

describe('shouldReclaimForVersion', () => {
  it('reclaims when the relay lacks AGENTBOX_CLI_ENTRY, regardless of version', () => {
    expect(shouldReclaimForVersion({ cliEntry: false }, '1.2.3')).toBe(true);
    expect(shouldReclaimForVersion({ cliEntry: false, version: '1.2.3' }, '1.2.3')).toBe(true);
    expect(shouldReclaimForVersion({ cliEntry: false, version: undefined }, undefined)).toBe(true);
  });

  it('reuses a capable relay whose version matches the current CLI', () => {
    expect(shouldReclaimForVersion({ cliEntry: true, version: '1.2.3' }, '1.2.3')).toBe(false);
  });

  it('reclaims a capable relay spawned by a different released version', () => {
    expect(shouldReclaimForVersion({ cliEntry: true, version: '1.2.3' }, '1.3.0')).toBe(true);
  });

  it('reuses (no churn) when the relay predates the version field', () => {
    expect(shouldReclaimForVersion({ cliEntry: true, version: undefined }, '1.2.3')).toBe(false);
    expect(shouldReclaimForVersion({}, '1.2.3')).toBe(false);
  });

  it('reuses when the current CLI version is unknown', () => {
    expect(shouldReclaimForVersion({ cliEntry: true, version: '1.2.3' }, undefined)).toBe(false);
  });

  it('never churns the relay across dev rebuilds (both 0.0.0-dev)', () => {
    expect(shouldReclaimForVersion({ cliEntry: true, version: '0.0.0-dev' }, '0.0.0-dev')).toBe(false);
  });

  it('reclaims a dev relay when a released CLI takes over', () => {
    expect(shouldReclaimForVersion({ cliEntry: true, version: '0.0.0-dev' }, '1.2.3')).toBe(true);
  });

  it('treats empty-string versions as unknown (no reclaim)', () => {
    expect(shouldReclaimForVersion({ cliEntry: true, version: '' }, '1.2.3')).toBe(false);
    expect(shouldReclaimForVersion({ cliEntry: true, version: '1.2.3' }, '')).toBe(false);
  });
});
