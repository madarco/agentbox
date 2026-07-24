import { describe, expect, it } from 'vitest';
import { PROVIDER_SECRET_KEYS, filterProviderSecrets } from '../src/control-plane-deploy.js';

// The deploy allowlist must stay in sync with what each provider's env-loader
// (`packages/sandbox-*/src/env-loader.ts`) actually reads at create time — a key
// that isn't copied lands the provider "not configured" on the control box. These
// tests pin the exact contract; the standout regression they guard is the Daytona
// JWT org id (was wrongly `DAYTONA_ORG_ID`; the real key is `DAYTONA_ORGANIZATION_ID`).
describe('PROVIDER_SECRET_KEYS (deploy → control box)', () => {
  const keys = new Set<string>(PROVIDER_SECRET_KEYS);

  it('carries the Daytona JWT org id under its real key, not the old wrong one', () => {
    expect(keys.has('DAYTONA_ORGANIZATION_ID')).toBe(true);
    expect(keys.has('DAYTONA_ORG_ID')).toBe(false);
  });

  it('includes every key each provider env-loader reads', () => {
    // Mirror of the env-loader `*_KEYS` consts (the source of truth).
    const required = [
      'HCLOUD_TOKEN',
      'HCLOUD_ENDPOINT',
      'E2B_API_KEY',
      'E2B_DOMAIN',
      'DAYTONA_API_KEY',
      'DAYTONA_JWT_TOKEN',
      'DAYTONA_ORGANIZATION_ID',
      'DAYTONA_API_URL',
      'DAYTONA_TARGET',
      'VERCEL_TOKEN',
      'VERCEL_OIDC_TOKEN',
      'VERCEL_TEAM_ID',
      'VERCEL_PROJECT_ID',
      'DIGITALOCEAN_TOKEN',
      'DIGITALOCEAN_API_URL',
    ];
    for (const k of required) expect(keys.has(k), `missing ${k}`).toBe(true);
  });

  it('deliberately excludes the Vercel CLI-login marker (no token would travel)', () => {
    expect(keys.has('VERCEL_AUTH_SOURCE')).toBe(false);
  });
});

describe('filterProviderSecrets', () => {
  it('migrates a JWT-mode Daytona setup WITH its org id + endpoint overrides', () => {
    const body = [
      'export DAYTONA_JWT_TOKEN=jwt-abc',
      'DAYTONA_ORGANIZATION_ID=org-123',
      'DAYTONA_API_URL=https://daytona.example',
      'HCLOUD_TOKEN=hc-secret',
      'HCLOUD_ENDPOINT=https://hetzner.example/v1',
      '',
      '# a comment',
      'UNRELATED_SECRET=do-not-leak',
      'VERCEL_AUTH_SOURCE=cli',
    ].join('\n');
    const out = filterProviderSecrets(body);
    expect(out).toContain('DAYTONA_JWT_TOKEN=jwt-abc');
    expect(out).toContain('DAYTONA_ORGANIZATION_ID=org-123'); // the fixed bug
    expect(out).toContain('DAYTONA_API_URL=https://daytona.example');
    expect(out).toContain('HCLOUD_ENDPOINT=https://hetzner.example/v1');
    // never forward unrelated secrets or the CLI-login marker
    expect(out).not.toContain('UNRELATED_SECRET');
    expect(out).not.toContain('VERCEL_AUTH_SOURCE');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('returns empty when the file holds no provider creds', () => {
    expect(filterProviderSecrets('FOO=bar\n# nothing\n')).toBe('');
  });
});
