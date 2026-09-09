import { describe, expect, it } from 'vitest';
import {
  defaultAgentFor,
  defaultProviderFor,
  lastUsedFromRegistrations,
  usableProvider,
} from '../lib/boxes/project-defaults';
import type { AgentOption, ProviderOption } from '../lib/boxes/types';

const provider = (id: string, extra: Partial<ProviderOption> = {}): ProviderOption => ({
  id,
  label: id,
  configured: true,
  ...extra,
});

const PROVIDERS: ProviderOption[] = [
  provider('docker'),
  provider('hetzner'),
  provider('e2b', { configured: false }),
  provider('vercel', { origin: 'hub' }),
  provider('docker:builder'),
];

const AGENTS: AgentOption[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];

describe('defaultProviderFor', () => {
  it('opens on what the project last used', () => {
    expect(defaultProviderFor({ lastProvider: 'hetzner' }, PROVIDERS)).toBe('hetzner');
  });

  it('round-trips a remote-docker host spec from an expanded list', () => {
    expect(defaultProviderFor({ lastProvider: 'docker:builder' }, PROVIDERS)).toBe(
      'docker:builder',
    );
  });

  it('falls back to docker when the memory is unusable', () => {
    // Never recorded, unbaked, owned by a control box, or gone from this host.
    expect(defaultProviderFor(undefined, PROVIDERS)).toBe('docker');
    expect(defaultProviderFor({ lastProvider: null }, PROVIDERS)).toBe('docker');
    expect(defaultProviderFor({ lastProvider: 'e2b' }, PROVIDERS)).toBe('docker');
    expect(defaultProviderFor({ lastProvider: 'vercel' }, PROVIDERS)).toBe('docker');
    expect(defaultProviderFor({ lastProvider: 'islo' }, PROVIDERS)).toBe('docker');
  });

  it('usableProvider is the picker-disabled predicate', () => {
    expect(usableProvider('hetzner', PROVIDERS)).toBe(true);
    expect(usableProvider('e2b', PROVIDERS)).toBe(false);
    expect(usableProvider('vercel', PROVIDERS)).toBe(false);
    expect(usableProvider(undefined, PROVIDERS)).toBe(false);
  });
});

describe('defaultAgentFor', () => {
  it('opens on what the project last used', () => {
    expect(defaultAgentFor({ lastAgent: 'codex' }, AGENTS)).toBe('codex');
  });

  it('falls back to claude for a removed plugin agent', () => {
    expect(defaultAgentFor({ lastAgent: 'some-plugin-agent' }, AGENTS)).toBe('claude');
    expect(defaultAgentFor(undefined, AGENTS)).toBe('claude');
  });

  it('falls back to the catalog head when claude is not offered', () => {
    expect(defaultAgentFor({ lastAgent: 'gone' }, [{ id: 'pi', label: 'Pi' }])).toBe('pi');
  });
});

describe('lastUsedFromRegistrations', () => {
  it('takes the newest registration and prefers backend over kind', () => {
    const out = lastUsedFromRegistrations([
      { kind: 'cloud', backend: 'e2b', agent: 'claude', registeredAt: '2026-01-01T00:00:00.000Z' },
      {
        kind: 'cloud',
        backend: 'hetzner',
        agent: 'codex',
        registeredAt: '2026-02-01T00:00:00.000Z',
      },
    ]);
    expect(out.lastProvider).toBe('hetzner');
    expect(out.lastAgent).toBe('codex');
    expect(out.lastUsedAt).toBe(Date.parse('2026-02-01T00:00:00.000Z'));
  });

  it('prefers createdAt over registeredAt, and falls back to kind', () => {
    const out = lastUsedFromRegistrations([
      {
        kind: 'cloud',
        createdAt: '2026-03-01T00:00:00.000Z',
        registeredAt: '2026-01-01T00:00:00.000Z',
      },
      { kind: 'cloud', backend: 'e2b', registeredAt: '2026-02-01T00:00:00.000Z' },
    ]);
    expect(out.lastProvider).toBe('cloud');
    expect(out.lastAgent).toBeUndefined();
  });

  it('drops an agentless registration and tolerates an empty list', () => {
    expect(
      lastUsedFromRegistrations([
        { backend: 'e2b', agent: 'none', registeredAt: '2026-02-01T00:00:00.000Z' },
      ]).lastAgent,
    ).toBeUndefined();
    expect(lastUsedFromRegistrations([])).toEqual({});
  });
});
