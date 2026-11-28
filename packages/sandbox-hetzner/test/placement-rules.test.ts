import { describe, expect, it } from 'vitest';
import { HETZNER_DEFAULT_SERVER_TYPE } from '../src/backend.js';
import {
  controlPlanePlacementWarnings,
  defaultServerTypeFor,
  lineOfferedAt,
} from '../src/placement-rules.js';

describe('defaultServerTypeFor (from the descriptor regions)', () => {
  it('keeps cx23 in the EU and with no location', () => {
    expect(defaultServerTypeFor('nbg1')).toBe(HETZNER_DEFAULT_SERVER_TYPE);
    expect(defaultServerTypeFor('hel1')).toBe('cx23');
    expect(defaultServerTypeFor(undefined)).toBe('cx23');
    expect(defaultServerTypeFor('xyz1')).toBe('cx23');
  });

  it('follows the location where cx is not offered, case-insensitively', () => {
    expect(defaultServerTypeFor('ash')).toBe('cpx21');
    expect(defaultServerTypeFor('HIL')).toBe('cpx21');
    expect(defaultServerTypeFor('sin')).toBe('cpx22');
  });
});

describe('lineOfferedAt', () => {
  it('encodes where each shared line is offered', () => {
    expect(lineOfferedAt('cx23', 'ash')).toBe(false);
    expect(lineOfferedAt('cx33', 'FSN1')).toBe(true);
    expect(lineOfferedAt('cpx21', 'nbg1')).toBe(false);
    expect(lineOfferedAt('cpx21', 'hil')).toBe(true);
    expect(lineOfferedAt('cpx22', 'ash')).toBe(false);
    expect(lineOfferedAt('cpx22', 'sin')).toBe(true);
    expect(lineOfferedAt('ccx13', 'sin')).toBeNull();
    expect(lineOfferedAt('cx23', 'xyz1')).toBeNull();
  });
});

describe('controlPlanePlacementWarnings', () => {
  it('is silent on the defaults', () => {
    expect(controlPlanePlacementWarnings('cx23', 'nbg1')).toEqual([]);
    expect(controlPlanePlacementWarnings('cpx21', 'ash')).toEqual([]);
  });

  it('warns under the floor, on Arm, and where the line is not offered', () => {
    expect(controlPlanePlacementWarnings('cpx11', 'ash')[0]).toMatch(/below/);
    expect(controlPlanePlacementWarnings('CPX12', 'sin')[0]).toMatch(/below/);
    expect(controlPlanePlacementWarnings('cax21', 'fsn1')[0]).toMatch(/Arm/);
    expect(controlPlanePlacementWarnings('cx23', 'ash')).toEqual([
      expect.stringMatching(/does not offer cx23 in ash.*cpx21/),
    ]);
  });
});

describe('serverChoiceFor (what a box create asks Hetzner for)', () => {
  it('defaults the size by location, so ash/hil/sin do not get cx23', async () => {
    const { serverChoiceFor } = await import('../src/backend.js');
    expect(serverChoiceFor({})).toEqual({ serverType: 'cx23', location: 'nbg1' });
    expect(serverChoiceFor({ location: 'ash' })).toEqual({ serverType: 'cpx21', location: 'ash' });
    expect(serverChoiceFor({ location: ' SIN ' })).toEqual({
      serverType: 'cpx22',
      location: 'sin',
    });
    // An explicit size is the user's, even where the preflight will refuse it.
    expect(serverChoiceFor({ size: 'cx33', location: 'ash' })).toEqual({
      serverType: 'cx33',
      location: 'ash',
    });
  });
});
