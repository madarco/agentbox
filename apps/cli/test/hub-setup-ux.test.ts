import { describe, expect, it } from 'vitest';
import {
  ghPreflightError,
  HUB_AUTH_REQUIRED_ERROR,
  INTERACTIVE_DEPLOY_OPTIONS,
  resolveDeployTarget,
} from '../src/commands/control-plane.js';

// Pure helpers only — no HOME writes, no network, no docker (apps/cli tests share
// the real ~/.agentbox, so these must never touch it).
describe('ghPreflightError (hub setup gh doctor check)', () => {
  it('passes when gh resolves on PATH', () => {
    expect(ghPreflightError('/usr/bin/gh')).toBeNull();
  });

  it('errors with an install hint when gh is missing', () => {
    const err = ghPreflightError(null);
    expect(err).not.toBeNull();
    // Must name gh, say it is required, and point at the install page.
    expect(err).toContain('`gh`');
    expect(err).toMatch(/required/i);
    expect(err).toContain('https://cli.github.com');
  });
});

describe('interactive deploy picker (Vercel hidden)', () => {
  it('does not offer Vercel in the picker', () => {
    const values = INTERACTIVE_DEPLOY_OPTIONS.map((o) => o.value);
    expect(values).not.toContain('vercel');
    // digitalocean joins local/hetzner as a surfaced VPS target; vercel stays hidden.
    expect(values).toEqual(['local', 'hetzner', 'digitalocean', 'none']);
  });

  it('still resolves --deploy vercel when passed explicitly', async () => {
    expect(await resolveDeployTarget('vercel')).toBe('vercel');
  });

  it('resolves the other explicit flags without prompting', async () => {
    expect(await resolveDeployTarget('hetzner')).toBe('hetzner');
    expect(await resolveDeployTarget('digitalocean')).toBe('digitalocean');
    expect(await resolveDeployTarget('local')).toBe('local');
    expect(await resolveDeployTarget('none')).toBe('none');
  });
});

describe('cancelling the hub login prompt', () => {
  // Every `hub setup` / `hub deploy` / `hub expose` path that reaches a deployed
  // profile now stops here instead of deploying "without web-UI auth". A hub with
  // no BETTER_AUTH_SECRET can authenticate nobody: it used to serve its whole UI
  // and API open, and now refuses every request with 503 — either way, continuing
  // past a cancelled prompt produces a hub the operator cannot use.
  it('explains that the login is required, not optional', () => {
    expect(HUB_AUTH_REQUIRED_ERROR).toMatch(/required/i);
    expect(HUB_AUTH_REQUIRED_ERROR).not.toMatch(/deploying without/i);
  });

  it('names the way out — the prompt, or the env file to pre-seed', () => {
    expect(HUB_AUTH_REQUIRED_ERROR).toContain('AGENTBOX_HUB_ADMIN_EMAIL');
    expect(HUB_AUTH_REQUIRED_ERROR).toContain('AGENTBOX_HUB_ADMIN_PASSWORD');
    expect(HUB_AUTH_REQUIRED_ERROR).toContain('BETTER_AUTH_SECRET');
    expect(HUB_AUTH_REQUIRED_ERROR).toContain('control-plane.env');
  });
});
