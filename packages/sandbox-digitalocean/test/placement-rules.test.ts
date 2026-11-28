import { describe, expect, it } from 'vitest';
import { controlPlanePlacementWarnings } from '../src/placement-rules.js';

describe('controlPlanePlacementWarnings (digitalocean)', () => {
  it('reads the floor off the slug', () => {
    expect(controlPlanePlacementWarnings('s-2vcpu-4gb')).toEqual([]);
    expect(controlPlanePlacementWarnings('s-8vcpu-16gb')).toEqual([]);
    expect(controlPlanePlacementWarnings('s-1vcpu-2gb')[0]).toMatch(/below/);
    expect(controlPlanePlacementWarnings('s-2vcpu-2gb')[0]).toMatch(/below/);
    expect(controlPlanePlacementWarnings('s-1vcpu-512mb-10gb')[0]).toMatch(/below/);
  });

  it('does not second-guess an opaque slug', () => {
    expect(controlPlanePlacementWarnings('c-4')).toEqual([]);
  });
});
