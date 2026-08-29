import { describe, expect, it } from 'vitest';
import { isRegionNotFound, vmRegionUnavailableMessage } from '../src/prepare-vm.js';

/**
 * `us-east-1` is a dedicated Daytona region, so an API key from an org that only
 * has the shared `us`/`eu` fails the VM bake with a bare `DaytonaNotFoundError`
 * and a stack — which reads as "AgentBox is broken". These pin the detection and
 * the guidance.
 */
describe('isRegionNotFound', () => {
  it('matches the SDK error the VM bake actually fails with', () => {
    const err = new Error('Region us-east-1 not found');
    expect(isRegionNotFound(err)).toBe(true);
  });

  it('matches a quoted region and ignores case', () => {
    expect(isRegionNotFound(new Error("region 'us-east-1' NOT FOUND"))).toBe(true);
  });

  // The API omits the id for some regions and includes it for others — both were
  // observed on 2026-08-29 with the same SDK and different keys. Pinning the id
  // let the bare form fall through to the raw stack trace.
  it('matches the bare form that carries no region id', () => {
    expect(isRegionNotFound(new Error('Region not found'))).toBe(true);
  });

  it('does not swallow unrelated failures', () => {
    expect(isRegionNotFound(new Error('build snapshot: rpc error'))).toBe(false);
    expect(isRegionNotFound(new Error('Snapshot not found'))).toBe(false);
  });
});

describe('vmRegionUnavailableMessage', () => {
  const msg = vmRegionUnavailableMessage('us-east-1');

  it('names the region and why it is missing', () => {
    expect(msg).toContain('us-east-1');
    expect(msg).toContain('dedicated');
  });

  it('points at the endpoint that shows what the account really has', () => {
    expect(msg).toContain('https://app.daytona.io/api/regions');
  });

  it('offers box.daytonaRegion for a future VM region', () => {
    expect(msg).toContain('box.daytonaRegion');
  });

  // Container sandboxes support neither snapshots nor base images, so steering a
  // user there trades this error for a worse dead end one long bake later.
  it('never recommends the container class as the fix', () => {
    expect(msg).not.toContain('daytonaClass');
    expect(msg).not.toContain('container');
  });
});
