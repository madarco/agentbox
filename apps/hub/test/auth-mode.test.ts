import { afterEach, describe, expect, it } from 'vitest';
import { authMode } from '../lib/auth-config';

// `authMode()` decides whether a hub gates anything at all. The case that matters
// is the deployed profile with no signing secret: it used to resolve to `off`,
// which served the entire UI and API — boxes, custody, git — to anyone who found
// the URL. That state is reachable by cancelling the login prompt during
// `hub setup` / `hub deploy`, and on vercel there is no redeploy path to undo it.

const KEYS = [
  'AGENTBOX_HUB_PROFILE',
  'AGENTBOX_HUB_AUTH',
  'BETTER_AUTH_SECRET',
  'AGENTBOX_HUB_TOKEN',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function env(vars: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('authMode', () => {
  describe('deployed profiles (hetzner / digitalocean / vercel)', () => {
    it('is `password` with a signing secret', () => {
      env({ AGENTBOX_HUB_PROFILE: 'hetzner', BETTER_AUTH_SECRET: 's' });
      expect(authMode()).toBe('password');
      env({ AGENTBOX_HUB_PROFILE: 'vercel', BETTER_AUTH_SECRET: 's' });
      expect(authMode()).toBe('password');
    });

    it('THE invariant: no secret is `locked`, never `off`', () => {
      // AGENTBOX_HUB_AUTH=on was already forced for non-localhost profiles, so the
      // old code ran better-auth with an undefined secret and no seeded admin.
      for (const auth of [undefined, 'on']) {
        env({ AGENTBOX_HUB_PROFILE: 'hetzner', ...(auth ? { AGENTBOX_HUB_AUTH: auth } : {}) });
        expect(authMode()).toBe('locked');
      }
      env({ AGENTBOX_HUB_PROFILE: 'vercel' });
      expect(authMode()).toBe('locked');
    });

    it('an empty secret is still `locked`', () => {
      env({ AGENTBOX_HUB_PROFILE: 'hetzner', BETTER_AUTH_SECRET: '' });
      expect(authMode()).toBe('locked');
    });

    it('turning auth off stays a deliberate act, not a missing variable', () => {
      env({ AGENTBOX_HUB_PROFILE: 'hetzner', AGENTBOX_HUB_AUTH: 'off' });
      expect(authMode()).toBe('off');
    });
  });

  describe('localhost profile', () => {
    it('is `token` once server.ts has provisioned a token', () => {
      env({ AGENTBOX_HUB_TOKEN: 'abc' });
      expect(authMode()).toBe('token');
    });

    it('is `off` with no token — a loopback hub is never `locked`', () => {
      env({});
      expect(authMode()).toBe('off');
      // A stray secret in the environment must not flip a local hub into password mode.
      env({ BETTER_AUTH_SECRET: 's' });
      expect(authMode()).toBe('off');
    });

    it('honours an explicit off even with a token', () => {
      env({ AGENTBOX_HUB_TOKEN: 'abc', AGENTBOX_HUB_AUTH: 'off' });
      expect(authMode()).toBe('off');
    });
  });
});
