import { describe, expect, it } from 'vitest';
import { daytonaPlacementVerdict } from '../src/placement-check.js';

describe('daytonaPlacementVerdict', () => {
  it('passes a region the snapshot was built in', () => {
    expect(daytonaPlacementVerdict({ region: 'us', snapshot: 'b', regionIds: ['us'] })).toEqual({
      offered: true,
    });
  });

  it('refuses a region the snapshot is not in, with the bake to run', () => {
    const v = daytonaPlacementVerdict({ region: 'eu', snapshot: 'b', regionIds: ['us'] });
    expect(v.offered).toBe(false);
    expect(v.reason).toMatch(/exists in us, not in 'eu'.*--force --location eu/);
  });

  it('refuses a linux-vm base anywhere but us-east-1', () => {
    expect(
      daytonaPlacementVerdict({ region: 'eu', snapshot: 'b', sandboxClass: 'linux-vm' }).offered,
    ).toBe(false);
    expect(
      daytonaPlacementVerdict({ region: 'us-east-1', snapshot: 'b', sandboxClass: 'linux-vm' }),
    ).toEqual({ offered: true });
  });

  it('says nothing when the regions are unknown', () => {
    expect(daytonaPlacementVerdict({ region: 'eu', snapshot: 'b', regionIds: undefined })).toEqual({
      offered: true,
    });
  });
});
