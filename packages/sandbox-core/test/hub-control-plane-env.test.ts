import { describe, expect, it } from 'vitest';
import { buildExposedHubEnv, scrubControlPlaneHubEnv } from '../src/hub-expose.js';

/**
 * `agentbox create` merges the whole of `control-plane.env` into `process.env`,
 * so on a machine with a control box configured the DEPLOYED box's profile and
 * credentials are ambient. A local hub spawned from there used to inherit them
 * and come up in the `hetzner` password profile, rejecting this machine's own
 * `~/.agentbox/hub/token` with "Missing or invalid credentials".
 */
const AMBIENT = {
  PATH: '/usr/bin',
  AGENTBOX_HUB_PROFILE: 'hetzner',
  AGENTBOX_HUB_AUTH: 'on',
  AGENTBOX_HUB_API_KEY: 'deployed-key',
  BETTER_AUTH_SECRET: 's',
  AGENTBOX_HUB_ADMIN_EMAIL: 'admin@example.com',
  AGENTBOX_HUB_ADMIN_PASSWORD: 'pw',
  AGENTBOX_RELAY_ADMIN_TOKEN: 'admin-token',
} satisfies NodeJS.ProcessEnv;

describe('scrubControlPlaneHubEnv', () => {
  it('drops the control box identity a local hub must not adopt', () => {
    const env = scrubControlPlaneHubEnv(AMBIENT);
    expect(env['AGENTBOX_HUB_PROFILE']).toBeUndefined();
    expect(env['AGENTBOX_HUB_AUTH']).toBeUndefined();
    expect(env['AGENTBOX_HUB_API_KEY']).toBeUndefined();
    expect(env['BETTER_AUTH_SECRET']).toBeUndefined();
    expect(env['AGENTBOX_HUB_ADMIN_EMAIL']).toBeUndefined();
    expect(env['AGENTBOX_HUB_ADMIN_PASSWORD']).toBeUndefined();
  });

  it('keeps everything else, including the relay admin token the CLI shares', () => {
    const env = scrubControlPlaneHubEnv(AMBIENT);
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['AGENTBOX_RELAY_ADMIN_TOKEN']).toBe('admin-token');
  });

  it('does not mutate the input', () => {
    const input = { ...AMBIENT };
    scrubControlPlaneHubEnv(input);
    expect(input.AGENTBOX_HUB_PROFILE).toBe('hetzner');
  });

  it('is undone by the exposed env, which is spread after it', () => {
    const exposed = buildExposedHubEnv(
      { provider: 'local', bind: '0.0.0.0' },
      { AGENTBOX_HUB_API_KEY: 'k', BETTER_AUTH_SECRET: 's' },
    );
    const child = { ...scrubControlPlaneHubEnv(AMBIENT), ...exposed };
    expect(child['AGENTBOX_HUB_PROFILE']).toBe('hetzner');
    expect(child['AGENTBOX_HUB_API_KEY']).toBe('k');
  });
});
