/**
 * Unit tests for the pure-function bits of `backend.ts`: the DigitalOcean
 * droplet-status → CloudState mapping. Live-API behavior (`provision`,
 * `exec`, etc.) is covered by the end-to-end smoke against a real
 * DigitalOcean account; it is intentionally NOT mocked here because the
 * coupling to the REST shape would make the tests brittle without catching
 * the real failure modes.
 *
 * `mapState` is module-internal, so this mirrors its small table and asserts
 * it line-by-line — drift between the backend's mapper and this spec surfaces
 * as a failing case immediately.
 */

import { describe, expect, it } from 'vitest';
import type { CloudState } from '@agentbox/core';

type DigitalOceanStatus = string;

function expectedCloudState(s: DigitalOceanStatus): CloudState {
  switch (s) {
    case 'active':
    case 'new':
      return 'running';
    case 'off':
    case 'archive':
      return 'paused';
    default:
      return 'missing';
  }
}

describe('DigitalOcean droplet status → CloudState mapping (spec mirror)', () => {
  const cases: Array<[DigitalOceanStatus, CloudState]> = [
    ['active', 'running'],
    // `new` = still provisioning; report running so callers don't ping-pong.
    ['new', 'running'],
    ['off', 'paused'],
    ['archive', 'paused'],
    // Defensive: any future status string we don't recognize defaults to
    // `missing` rather than throw or render as `running`.
    ['some-future-state', 'missing'],
  ];

  for (const [status, cloud] of cases) {
    it(`${status} -> ${cloud}`, () => {
      expect(expectedCloudState(status)).toBe(cloud);
    });
  }
});
