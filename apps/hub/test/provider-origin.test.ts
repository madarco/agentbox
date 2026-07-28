import { describe, expect, it } from 'vitest';
import { mergeRemoteProviders } from '../lib/boxes/provider-origin';
import type { ProviderOption } from '../lib/boxes/types';

function local(): ProviderOption[] {
  return [
    { id: 'docker', label: 'Docker (local)', configured: true, baseStatus: 'fresh' },
    { id: 'remote-docker', label: 'Remote Docker', configured: true },
    // This host has hetzner baked and e2b not — neither of which a create on the
    // control box would consult.
    { id: 'hetzner', label: 'Hetzner', configured: true, hasCredentials: true, baseStatus: 'stale' },
    { id: 'e2b', label: 'E2B', configured: false, hasCredentials: false },
  ];
}

const byId = (rows: ProviderOption[], id: string): ProviderOption =>
  rows.find((r) => r.id === id)!;

describe('mergeRemoteProviders', () => {
  it('leaves everything local when no control box is configured', () => {
    const rows = mergeRemoteProviders({ local: local(), remote: undefined });
    expect(rows).toEqual(local());
  });

  it('takes the control box readiness for cloud rows and keeps docker local', () => {
    const rows = mergeRemoteProviders({
      local: local(),
      hubUrl: 'https://hub.example',
      remote: [
        { id: 'hetzner', label: 'hetzner', configured: false, hasCredentials: true },
        { id: 'e2b', label: 'e2b', configured: true, hasCredentials: true, baseStatus: 'fresh' },
      ],
    });
    // Docker's base is a local image — no other host can answer for it.
    expect(byId(rows, 'docker')).toMatchObject({ origin: 'local', configured: true });
    expect(byId(rows, 'remote-docker')).toMatchObject({ origin: 'local' });
    // The verdicts INVERT vs local state, which is the whole point.
    expect(byId(rows, 'hetzner')).toMatchObject({
      origin: 'hub',
      hubUrl: 'https://hub.example',
      configured: false,
    });
    expect(byId(rows, 'hetzner').baseStatus).toBeUndefined();
    expect(byId(rows, 'e2b')).toMatchObject({ origin: 'hub', configured: true, baseStatus: 'fresh' });
  });

  it('keeps the local label so the picker reads consistently', () => {
    const rows = mergeRemoteProviders({
      local: local(),
      remote: [{ id: 'e2b', label: 'e2b (cloud, whatever the hub calls it)', configured: true }],
    });
    expect(byId(rows, 'e2b').label).toBe('E2B');
  });

  it('reports unknown — never this host’s state — when the control box is unreachable', () => {
    const rows = mergeRemoteProviders({ local: local(), remote: null, hubUrl: 'https://hub.example' });
    const hetzner = byId(rows, 'hetzner');
    // Locally this row is `configured: true`. Showing that under a "control box"
    // label would be a claim about a machine we did not reach.
    expect(hetzner.configured).toBe(false);
    expect(hetzner.origin).toBe('hub');
    expect(hetzner.reason).toContain('unreachable');
    expect(hetzner.baseStatus).toBeUndefined();
    // Not `false` — "no credentials there" is a claim we have no basis for.
    expect(hetzner.hasCredentials).toBeUndefined();
    // Docker is unaffected by a control box being down.
    expect(byId(rows, 'docker')).toMatchObject({ origin: 'local', configured: true });
  });

  it('marks a provider the control box does not have as not set up there', () => {
    const rows = mergeRemoteProviders({ local: local(), remote: [] });
    expect(byId(rows, 'hetzner')).toMatchObject({ origin: 'hub', configured: false });
    expect(byId(rows, 'hetzner').reason).toContain('control box');
  });
});
