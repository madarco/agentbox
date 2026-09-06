/**
 * Guard the descriptors' declared `sizes` against the parsers that have to
 * accept them.
 *
 * A size key is a literal `--size` value for one backend, so a typo here is
 * invisible until someone picks it in the create form and the box fails to
 * provision. Three providers parse the spec locally and can be asked directly;
 * hetzner and digitalocean take opaque slugs their API validates, so those get
 * a shape check only.
 *
 * Lives in apps/cli because `@agentbox/config` cannot depend on the provider
 * packages (they depend on it) — same reason as `provider-descriptors.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '@agentbox/config';
import { DAYTONA_DEFAULT_RESOURCES, parseDaytonaSize } from '@agentbox/sandbox-daytona';
import { DIGITALOCEAN_DEFAULT_SIZE } from '@agentbox/sandbox-digitalocean';
import { DEFAULT_CPU, DEFAULT_MEMORY_MB, parseE2bSize } from '@agentbox/sandbox-e2b';
import { HETZNER_DEFAULT_SERVER_TYPE } from '@agentbox/sandbox-hetzner';
import { parseVercelVcpus, VERCEL_DEFAULT_VCPUS } from '@agentbox/sandbox-vercel';

function descriptor(name: string) {
  const d = PROVIDERS.find((p) => p.name === name);
  if (!d) throw new Error(`no descriptor for ${name}`);
  return d as (typeof PROVIDERS)[number] & {
    sizes?: readonly { key: string; label: string }[];
    sizeHint?: string;
    sizeAppliesAt?: 'create' | 'bake';
  };
}

function sizesOf(name: string): readonly { key: string; label: string }[] {
  return descriptor(name).sizes ?? [];
}

describe('declared provider sizes', () => {
  it('docker declares none — its knobs are box.memory / box.cpus', () => {
    expect(descriptor('docker').sizes).toBeUndefined();
  });

  it('every other provider declares at least two', () => {
    for (const p of PROVIDERS) {
      if (p.name === 'docker') continue;
      expect(sizesOf(p.name).length, p.name).toBeGreaterThan(1);
    }
  });

  it('keys are unique and labels non-empty', () => {
    for (const p of PROVIDERS) {
      const sizes = sizesOf(p.name);
      expect(new Set(sizes.map((s) => s.key)).size, p.name).toBe(sizes.length);
      for (const s of sizes) expect(s.label.trim().length, `${p.name}/${s.key}`).toBeGreaterThan(0);
    }
  });

  it('daytona keys parse as cpu-memory-disk', () => {
    for (const { key } of sizesOf('daytona')) {
      expect(parseDaytonaSize(key), key).toBeDefined();
    }
  });

  it('e2b keys parse as cpu-memory', () => {
    for (const { key } of sizesOf('e2b')) {
      expect(parseE2bSize(key), key).toBeDefined();
    }
  });

  it('vercel keys are accepted vCPU counts', () => {
    for (const { key } of sizesOf('vercel')) {
      expect(() => parseVercelVcpus(key), key).not.toThrow();
    }
  });

  it('vercel declares no sizeHint — its set is closed, so no custom-value escape', () => {
    // `parseVercelVcpus` throws outside the declared set, so a UI offering a
    // free-text box here would only ever produce a failed create.
    expect(descriptor('vercel').sizeHint).toBeUndefined();
    expect(() => parseVercelVcpus('3')).toThrow();
  });

  it('every open list carries a hint for its custom-value field', () => {
    for (const p of PROVIDERS) {
      if (p.name === 'docker' || p.name === 'vercel') continue;
      expect(descriptor(p.name).sizeHint, p.name).toBeTruthy();
    }
  });

  it('slug providers declare plausible slugs', () => {
    for (const name of ['hetzner', 'digitalocean']) {
      for (const { key } of sizesOf(name)) {
        expect(key, `${name}/${key}`).toMatch(/^[a-z0-9-]+$/);
      }
    }
  });

  // The picker labels one entry "(default)" — the size you get with no --size.
  // That is a claim about the backend, so pin it to the backend's own constant
  // rather than to a comment someone has to remember to update.
  it.each([
    [
      'daytona',
      `${String(DAYTONA_DEFAULT_RESOURCES.cpu)}-${String(DAYTONA_DEFAULT_RESOURCES.memory)}-${String(DAYTONA_DEFAULT_RESOURCES.disk)}`,
    ],
    ['hetzner', HETZNER_DEFAULT_SERVER_TYPE],
    ['vercel', String(VERCEL_DEFAULT_VCPUS)],
    ['e2b', `${String(DEFAULT_CPU)}-${String(DEFAULT_MEMORY_MB / 1024)}`],
    ['digitalocean', DIGITALOCEAN_DEFAULT_SIZE],
  ])('%s labels its real fallback size as the default', (name, expected) => {
    const marked = sizesOf(name).filter((s) => s.label.includes('(default)'));
    expect(marked.map((s) => s.key)).toEqual([expected]);
  });

  it('bake-scoped providers are exactly the ones with a sizeIgnoredReason hook', async () => {
    // The two are the same fact: a size fixed at bake time is one the backend
    // rejects per-create, which is what `sizeIgnoredReason` reports. If a new
    // provider grows one without the other, a UI either offers a dead control
    // or bakes when it did not need to.
    const baked = PROVIDERS.filter((p) => descriptor(p.name).sizeAppliesAt === 'bake').map(
      (p) => p.name,
    );
    expect([...baked].sort()).toEqual(['daytona', 'e2b']);
  });
});
