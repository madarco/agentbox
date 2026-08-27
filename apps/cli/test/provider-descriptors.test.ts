/**
 * Guard the BUILT-IN descriptor table against the real provider modules.
 *
 * The table is hand-authored because method presence on `Provider` is not a
 * capability signal — `createCloudProvider` defines `setInbound`,
 * `repairReachability`, `enableDirectGit` and `checkpoint` on every cloud
 * provider, and docker has working checkpoints with no `provider.checkpoint` at
 * all. See `packages/config/src/providers.ts`.
 *
 * `CloudBackend` methods ARE authored per provider, so the three capabilities
 * that mirror one must agree with it. Those are asserted here; the rest of the
 * table is prose that only a human can check.
 *
 * This lives in apps/cli because `@agentbox/config` cannot depend on the
 * provider packages (they depend on it).
 */

import { describe, expect, it } from 'vitest';
import { PROVIDERS, type ProviderCapabilities, type ProviderKind } from '@agentbox/config';
import type { ProviderModule } from '@agentbox/sandbox-core';

const IMPORTERS: Record<ProviderKind, () => Promise<{ providerModule: ProviderModule }>> = {
  docker: () => import('@agentbox/sandbox-docker'),
  daytona: () => import('@agentbox/sandbox-daytona'),
  hetzner: () => import('@agentbox/sandbox-hetzner'),
  vercel: () => import('@agentbox/sandbox-vercel'),
  e2b: () => import('@agentbox/sandbox-e2b'),
  digitalocean: () => import('@agentbox/sandbox-digitalocean'),
  'remote-docker': () => import('@agentbox/sandbox-remote-docker'),
};

describe('built-in descriptors agree with their modules', () => {
  it.each(PROVIDERS.map((p) => p.name))('%s', async (name) => {
    const { providerModule } = await IMPORTERS[name]();
    const declared = PROVIDERS.find((p) => p.name === name);
    expect(declared).toBeDefined();
    if (!declared) return;
    const backend = providerModule.backend;

    // `kind` is what tells the hub whether to expect a CloudBackend at all.
    expect(declared.kind, `${name}.kind`).toBe(backend ? 'cloud' : 'local');

    // prune ⇔ backend.list — matches the retired CLOUD_PRUNE_PROVIDERS exactly.
    expect(declared.capabilities.prune, `${name}.capabilities.prune`).toBe(!!backend?.list);

    // inbound ⇔ backend.setInbound — true for the two VPS providers only.
    expect(declared.capabilities.inbound, `${name}.capabilities.inbound`).toBe(
      !!backend?.setInbound,
    );

    // timeoutModel is copied, not invented. (`as const` narrows each row to its
    // own literal type, so rows that omit the optional key lose it from the
    // union — read it through the interface.)
    const caps: ProviderCapabilities = declared.capabilities;
    expect(caps.timeoutModel, `${name}.capabilities.timeoutModel`).toBe(backend?.timeoutModel);
  });

  it('a credential form is declared only where setCredentials can consume it', async () => {
    for (const p of PROVIDERS) {
      const { providerModule } = await IMPORTERS[p.name]();
      // The field keys go straight to setCredentials; declaring fields for a
      // module that has no such method would render a form that cannot save.
      if (p.credentials.fields.length > 0) {
        expect(providerModule.setCredentials, `${p.name} declares fields`).toBeDefined();
      }
    }
  });

  it('every provider the table calls bakeable actually has a prepare', async () => {
    for (const p of PROVIDERS) {
      if (!p.bake.required) continue;
      const { providerModule } = await IMPORTERS[p.name]();
      expect(providerModule.provider.prepare, `${p.name} needs a prepare`).toBeDefined();
    }
  });
});
