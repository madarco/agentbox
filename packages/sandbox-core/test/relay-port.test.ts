import { afterEach, describe, expect, it } from 'vitest';
import {
  FALLBACK_RELAY_PORT,
  isValidRelayPort,
  RELAY_PORT_ENV,
  relayPort,
  resetRelayPort,
  setRelayPort,
} from '../src/relay-port.js';

/**
 * `relay.port` was declared and documented but never read, so the relay always
 * bound 8787 and a user whose port was taken had no supported escape hatch
 * (issue #301). This is the resolver every probe, spawn and box-facing URL now
 * goes through.
 */
afterEach(() => {
  resetRelayPort();
});

describe('relayPort resolution', () => {
  it('falls back to 8787 when nothing is set', () => {
    expect(relayPort()).toBe(FALLBACK_RELAY_PORT);
    expect(FALLBACK_RELAY_PORT).toBe(8787);
  });

  it('reads the env var, so a spawned child agrees with its parent', () => {
    process.env[RELAY_PORT_ENV] = '8799';
    expect(relayPort()).toBe(8799);
  });

  it('an explicit setRelayPort wins over the env var', () => {
    process.env[RELAY_PORT_ENV] = '8799';
    setRelayPort(9100);
    expect(relayPort()).toBe(9100);
  });

  it('mirrors into the env so child processes inherit it', () => {
    setRelayPort(9100);
    expect(process.env[RELAY_PORT_ENV]).toBe('9100');
  });

  it('ignores a junk env value rather than binding NaN', () => {
    process.env[RELAY_PORT_ENV] = 'not-a-port';
    expect(relayPort()).toBe(FALLBACK_RELAY_PORT);
  });

  it('ignores an out-of-range setRelayPort rather than leaving it unbindable', () => {
    setRelayPort(70000);
    expect(relayPort()).toBe(FALLBACK_RELAY_PORT);
    setRelayPort(0);
    expect(relayPort()).toBe(FALLBACK_RELAY_PORT);
  });
});

describe('isValidRelayPort', () => {
  it('accepts the bindable range', () => {
    expect(isValidRelayPort(1)).toBe(true);
    expect(isValidRelayPort(8787)).toBe(true);
    expect(isValidRelayPort(65535)).toBe(true);
  });

  it('rejects out-of-range and non-integers', () => {
    for (const bad of [0, -1, 65536, 1.5, Number.NaN]) {
      expect(isValidRelayPort(bad)).toBe(false);
    }
  });
});
