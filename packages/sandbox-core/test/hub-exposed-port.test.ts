import { afterEach, describe, expect, it } from 'vitest';
import { buildExposedHubEnv } from '../src/hub-expose.js';
import { isValidRelayPort, relayPort, resetRelayPort, setRelayPort } from '../src/relay-port.js';

/**
 * An exposed hub's port is a deployment fact — bind, tunnel and firewall are all
 * provisioned against the port in the deploy record, and `buildExposedHubEnv`
 * passes it to the child as AGENTBOX_HUB_PORT.
 *
 * Regression: `spawnHub` sets AGENTBOX_HUB_PORT from `relayPort()` and then
 * spreads the exposed env over it, so on an exposed machine the child binds the
 * RECORD's port. If this process kept probing `relay.port`, every /healthz would
 * miss and a healthy hub would read as dead (or as a port collision). `ensureHub`
 * therefore adopts the record's port before it probes anything.
 */
afterEach(() => {
  resetRelayPort();
});

const CREDS = { AGENTBOX_HUB_API_KEY: 'k' };

describe('exposed hub port', () => {
  it('is carried to the child as AGENTBOX_HUB_PORT', () => {
    const env = buildExposedHubEnv({ provider: 'local', bind: '0.0.0.0', port: 8790 }, CREDS);
    expect(env['AGENTBOX_HUB_PORT']).toBe('8790');
  });

  it('wins over relay.port, because the child binds it (the spread order)', () => {
    setRelayPort(8799);
    const env = buildExposedHubEnv({ provider: 'local', port: 8790 }, CREDS);
    const childPort = { AGENTBOX_HUB_PORT: String(relayPort()), ...env }['AGENTBOX_HUB_PORT'];
    expect(childPort).toBe('8790');
  });

  it('is a valid port, so ensureHub can adopt it', () => {
    const env = buildExposedHubEnv({ provider: 'local', port: 8790 }, CREDS);
    const adopted = Number.parseInt(env['AGENTBOX_HUB_PORT'] ?? '', 10);
    expect(isValidRelayPort(adopted)).toBe(true);
    setRelayPort(adopted);
    // Once adopted, probes and the child agree — the bug was these diverging.
    expect(relayPort()).toBe(adopted);
  });

  it('leaves relay.port alone when the record pins no port', () => {
    setRelayPort(8799);
    const env = buildExposedHubEnv({ provider: 'local' }, CREDS);
    expect(env['AGENTBOX_HUB_PORT']).toBeUndefined();
    expect(relayPort()).toBe(8799);
  });
});
