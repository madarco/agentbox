import { describe, expect, it } from 'vitest';
import {
  ghPreflightError,
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
    expect(values).toEqual(['local', 'hetzner', 'none']);
  });

  it('still resolves --deploy vercel when passed explicitly', async () => {
    expect(await resolveDeployTarget('vercel')).toBe('vercel');
  });

  it('resolves the other explicit flags without prompting', async () => {
    expect(await resolveDeployTarget('hetzner')).toBe('hetzner');
    expect(await resolveDeployTarget('local')).toBe('local');
    expect(await resolveDeployTarget('none')).toBe('none');
  });
});
