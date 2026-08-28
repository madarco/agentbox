import { describe, expect, it } from 'vitest';
import { describeToolGrantPush } from '../src/lib/tool-grant-push.js';

/**
 * The report matters as much as the push: boxes no longer poll for grants, so a
 * box that did not take the change is the box where the tool will be missing.
 * Silence there would be the old "picks it up within a minute" promise, except
 * now it would be false.
 */
describe('describeToolGrantPush', () => {
  it('says nothing when there was nothing running to tell', () => {
    expect(describeToolGrantPush({ relinked: [], failed: [] })).toBeNull();
  });

  it('names the boxes that took the change', () => {
    expect(describeToolGrantPush({ relinked: ['api', 'web'], failed: [] })).toBe(
      'applied in api, web',
    );
  });

  it('names an unreachable box, its reason, and when it will catch up', () => {
    const line = describeToolGrantPush({
      relinked: ['api'],
      failed: [{ name: 'web', reason: 'no answer within 8000ms' }],
    });
    expect(line).toMatch(/applied in api/);
    expect(line).toMatch(/could not reach web \(no answer within 8000ms\)/);
    expect(line).toMatch(/when its daemon next starts/);
  });
});
