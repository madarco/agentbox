import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  PROVIDER_NAMES,
  CLOUD_PROVIDER_NAMES,
  HUB_ROUTABLE_PROVIDER_NAMES,
  isHubRoutableProvider,
  perProviderConfigKey,
} from '../src/providers.js';
import { BUILT_IN_DEFAULTS, lookupKey } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(resolve(here, '..', 'schema', 'user-config.schema.json'), 'utf8'),
) as { properties: { box: { properties: Record<string, unknown> } } };
const boxSchemaKeys = schema.properties.box.properties;

const BASES = ['image', 'size', 'defaultCheckpoint'] as const;

describe('provider table is the single source of truth', () => {
  it('every provider has all three per-provider keys registered in KEY_REGISTRY', () => {
    for (const p of PROVIDERS) {
      for (const base of BASES) {
        const key = perProviderConfigKey(base, p.name);
        expect(lookupKey(key), `${key} missing from KEY_REGISTRY`).toBeDefined();
      }
    }
  });

  it('every per-provider key exists in the JSON schema (parser ↔ schema agreement)', () => {
    // The schema uses additionalProperties:false, so a KEY_REGISTRY entry
    // without a matching schema key would make config files fail validation.
    for (const p of PROVIDERS) {
      for (const base of BASES) {
        const leaf = perProviderConfigKey(base, p.name).slice('box.'.length);
        expect(
          boxSchemaKeys[leaf],
          `box.${leaf} missing from user-config.schema.json`,
        ).toBeDefined();
      }
    }
  });

  it('every per-provider key has a built-in default (EffectiveConfig is total)', () => {
    const box = BUILT_IN_DEFAULTS.box as unknown as Record<string, unknown>;
    for (const p of PROVIDERS) {
      for (const base of BASES) {
        const leaf = perProviderConfigKey(base, p.name).slice('box.'.length);
        expect(typeof box[leaf], `${leaf} missing from BUILT_IN_DEFAULTS.box`).toBe('string');
      }
    }
  });

  it('box.provider enum matches PROVIDER_NAMES exactly', () => {
    const desc = lookupKey('box.provider');
    expect(desc?.enumValues).toEqual([...PROVIDER_NAMES]);
  });

  it('docker is the only local provider; the rest are cloud', () => {
    expect(PROVIDERS.find((p) => p.name === 'docker')?.kind).toBe('local');
    expect(CLOUD_PROVIDER_NAMES).not.toContain('docker');
    expect([...CLOUD_PROVIDER_NAMES].sort()).toEqual(
      PROVIDERS.filter((p) => p.name !== 'docker')
        .map((p) => p.name)
        .sort(),
    );
  });

  it('hub-routable providers are the clouds MINUS remote-docker (the control box can reach them)', () => {
    // remote-docker is kind:'cloud' for staging/sync, but its box runs on YOUR
    // machine over YOUR ssh config — the control box can't reach it, so a create
    // must never route to the hub for it (nor for docker).
    expect(HUB_ROUTABLE_PROVIDER_NAMES).not.toContain('docker');
    expect(HUB_ROUTABLE_PROVIDER_NAMES).not.toContain('remote-docker');
    expect([...HUB_ROUTABLE_PROVIDER_NAMES].sort()).toEqual(
      CLOUD_PROVIDER_NAMES.filter((n) => n !== 'remote-docker')
        .slice()
        .sort(),
    );
    expect(isHubRoutableProvider('e2b')).toBe(true);
    expect(isHubRoutableProvider('hetzner')).toBe(true);
    expect(isHubRoutableProvider('docker')).toBe(false);
    expect(isHubRoutableProvider('remote-docker')).toBe(false);
    expect(isHubRoutableProvider('nonsense')).toBe(false);
  });

  // The descriptor is the contract every UI reads. A row missing a field would
  // surface as an undefined capability in the tray/web create pickers rather than
  // as a type error, since `satisfies` only checks what is present.
  describe('every row declares a complete descriptor', () => {
    const CAPS = [
      'checkpoints',
      'checkpointReboots',
      'ssh',
      'persistentSsh',
      'directBoxSsh',
      'inbound',
      'directGit',
      'resync',
      'prune',
      'vnc',
      'dind',
      'pauseSemantics',
      'hubRoutable',
    ] as const;

    it.each(PROVIDERS.map((p) => p.name))('%s', (name) => {
      const p = PROVIDERS.find((x) => x.name === name);
      expect(p).toBeDefined();
      if (!p) return;
      expect(Array.isArray(p.credentials.envKeys)).toBe(true);
      expect(Array.isArray(p.credentials.fields)).toBe(true);
      expect(typeof p.bake.required).toBe('boolean');
      expect(p.bake.approxMinutes).toBeTruthy();
      const caps = p.capabilities as unknown as Record<string, unknown>;
      for (const c of CAPS) expect(caps[c], `${name}.capabilities.${c}`).toBeDefined();
      expect(['freeze', 'stop']).toContain(p.capabilities.pauseSemantics);
    });

    it('a credential field maps to a key setCredentials understands', () => {
      // The field `key` is passed verbatim to ProviderModule.setCredentials, so a
      // provider that declares fields must have somewhere to put them.
      for (const p of PROVIDERS) {
        if (p.credentials.fields.length === 0) continue;
        expect(
          p.credentials.envKeys.length,
          `${p.name} declares fields but no envKeys`,
        ).toBeGreaterThan(0);
        for (const f of p.credentials.fields) {
          expect(f.key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
          expect(f.label).toBeTruthy();
        }
      }
    });

    it('only providers that need a bake demand one', () => {
      // docker's base self-heals on create; remote-docker builds lazily on first
      // create. Everything else is unusable until `agentbox prepare` has run.
      expect(PROVIDERS.filter((p) => !p.bake.required).map((p) => p.name)).toEqual([
        'docker',
        'remote-docker',
      ]);
    });
  });

  it('cloud.viaHub defaults on (remote hub is the default for cloud creates)', () => {
    const cloud = BUILT_IN_DEFAULTS.cloud as unknown as { viaHub: boolean };
    expect(cloud.viaHub).toBe(true);
    expect(lookupKey('cloud.viaHub')?.type).toBe('bool');
  });

  // `loginHint` is what the install wizard shows next to each provider, so it has
  // to describe the flow the user is about to get. Daytona's said "approve a
  // browser sign-in link" — but its login never does OAuth: it offers to open the
  // dashboard's keys page and then prompts you to PASTE a key
  // (packages/sandbox-daytona/src/credentials.ts). Vercel is the one provider
  // that genuinely signs you in through a browser, and the wrong Daytona copy was
  // cloned from it — so pin both, or the fix rots back.
  describe('loginHint describes the real flow', () => {
    const hintFor = (name: string): string =>
      PROVIDERS.find((p) => p.name === name)?.loginHint ?? '';

    it('daytona says paste-a-key, not browser sign-in', () => {
      expect(hintFor('daytona')).toMatch(/paste an API key/i);
      expect(hintFor('daytona')).not.toMatch(/sign-?in|browser|oauth|approve/i);
    });

    it('vercel keeps its browser sign-in — it really does OAuth', () => {
      expect(hintFor('vercel')).toMatch(/browser sign-?in/i);
    });

    it('the other paste-a-token providers stay paste-a-token', () => {
      for (const name of ['hetzner', 'e2b', 'digitalocean']) {
        expect(hintFor(name)).toMatch(/paste/i);
        expect(hintFor(name)).not.toMatch(/browser|sign-?in/i);
      }
    });
  });
});
