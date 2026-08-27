/**
 * Descriptor resolution, and — the part that matters most — what a provider
 * PLUGIN that predates descriptors resolves to. Those defaults are load-bearing
 * back-compat: each one reproduces what AgentBox did for a plugin before
 * descriptors existed, so registering an old plugin against a new CLI can only
 * add capability, never remove it.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderModule } from '../src/doctor.js';
import type { PluginsFile } from '../src/plugin-registry.js';
import {
  deriveDescriptor,
  ensureProviderDescriptor,
  listProviderDescriptors,
  resolveProviderDescriptor,
} from '../src/provider-descriptor.js';

let dir: string;
let registry: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentbox-desc-'));
  registry = join(dir, 'plugins.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeRegistry(file: PluginsFile): void {
  writeFileSync(registry, JSON.stringify(file, null, 2), 'utf8');
}

/** A minimal module shaped like a 2.6.0-era plugin: no `descriptor` export. */
function legacyModule(over: Partial<ProviderModule> = {}): ProviderModule {
  return {
    provider: { name: 'acme' } as ProviderModule['provider'],
    doctorChecks: () => Promise.resolve([]),
    ...over,
  };
}

describe('resolveProviderDescriptor', () => {
  it('returns the built-in table entry for a built-in', () => {
    const d = resolveProviderDescriptor('hetzner', registry);
    expect(d?.name).toBe('hetzner');
    expect(d?.kind).toBe('cloud');
    expect(d?.capabilities.inbound).toBe(true);
  });

  it('returns undefined for a name nothing provides', () => {
    expect(resolveProviderDescriptor('nope', registry)).toBeUndefined();
  });

  it('reads a plugin snapshot from the registry', () => {
    const descriptor = deriveDescriptor('acme', legacyModule());
    writeRegistry({
      version: 2,
      plugins: [
        {
          packageName: 'agentbox-provider-acme',
          resolvedEntry: '/tmp/acme/index.js',
          version: '1.0.0',
          providers: ['acme'],
          descriptors: { acme: { ...descriptor, label: 'Acme Cloud' } },
          apiVersion: 2,
          addedAt: new Date(0).toISOString(),
        },
      ],
    });
    expect(resolveProviderDescriptor('acme', registry)?.label).toBe('Acme Cloud');
  });
});

describe('a v1 registry (no descriptors) still works', () => {
  beforeEach(() => {
    // Exactly what an existing user's plugins.json looks like today.
    writeFileSync(
      registry,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            packageName: 'agentbox-provider-acme',
            resolvedEntry: '/tmp/acme/index.js',
            version: '1.0.0',
            providers: ['acme'],
            apiVersion: 1,
            addedAt: new Date(0).toISOString(),
          },
        ],
      }),
      'utf8',
    );
  });

  it('the provider is still LISTED — never hidden for lacking a snapshot', () => {
    const names = listProviderDescriptors(registry).map((d) => d.name);
    expect(names).toContain('acme');
    expect(names).toContain('docker');
  });

  it('back-fills the snapshot the first time a module is available', async () => {
    const d = await ensureProviderDescriptor('acme', legacyModule(), registry);
    expect(d.name).toBe('acme');
    expect(resolveProviderDescriptor('acme', registry)?.name).toBe('acme');
    const after = JSON.parse(readFileSync(registry, 'utf8')) as PluginsFile;
    expect(after.version).toBe(2);
    expect(after.plugins[0]?.descriptors?.acme).toBeDefined();
  });
});

describe('fallback defaults preserve pre-descriptor behavior', () => {
  it('does NOT demand a bake — that would newly block creates that work today', () => {
    // The hub's create gate deliberately skips isProviderConfigured for plugins.
    expect(deriveDescriptor('acme', legacyModule()).bake.required).toBe(false);
  });

  it('keeps VNC and DinD ON — the cloud scaffold wires both unconditionally', () => {
    const caps = deriveDescriptor('acme', legacyModule()).capabilities;
    expect(caps.vnc).toBe(true);
    expect(caps.dind).toBe(true);
  });

  it("keeps pause labelled 'freeze' — the pre-descriptor UI showed a plain Pause", () => {
    expect(deriveDescriptor('acme', legacyModule()).capabilities.pauseSemantics).toBe('freeze');
  });

  it('leaves the SSH capabilities OFF — plugins were excluded from those lists', () => {
    const caps = deriveDescriptor('acme', legacyModule()).capabilities;
    expect(caps.persistentSsh).toBe(false);
    expect(caps.directBoxSsh).toBe(false);
  });

  it('offers a credential form only when the module can consume one', () => {
    expect(deriveDescriptor('acme', legacyModule()).credentials.fields).toEqual([]);
    const withCreds = legacyModule({
      setCredentials: () => Promise.resolve({ ok: true, status: { configured: true } }),
    });
    expect(deriveDescriptor('acme', withCreds).credentials.fields).toEqual([
      { key: 'apiKey', label: 'API key' },
    ]);
  });
});

describe('derivation reads BACKEND methods, not provider methods', () => {
  it('derives prune / inbound / timeoutModel from the backend', () => {
    const mod = legacyModule({
      backend: {
        name: 'acme',
        list: () => Promise.resolve([]),
        setInbound: () => Promise.resolve({ sources: [] }),
        timeoutModel: 'absolute',
      } as unknown as ProviderModule['backend'],
    });
    const caps = deriveDescriptor('acme', mod).capabilities;
    expect(caps.prune).toBe(true);
    expect(caps.inbound).toBe(true);
    expect(caps.timeoutModel).toBe('absolute');
  });

  it('a backend-less module is local and prunes nothing', () => {
    const d = deriveDescriptor('acme', legacyModule());
    expect(d.kind).toBe('local');
    expect(d.capabilities.prune).toBe(false);
    expect(d.capabilities.inbound).toBe(false);
  });

  it('a declared descriptor wins over every derivation', () => {
    const declared = { ...deriveDescriptor('acme', legacyModule()), label: 'Declared' };
    const mod = legacyModule({ descriptor: declared });
    expect(deriveDescriptor('acme', mod).label).toBe('Declared');
  });
});
