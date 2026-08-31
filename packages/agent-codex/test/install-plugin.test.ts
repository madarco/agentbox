import { describe, expect, it } from 'vitest';
import { marketplaceSource, installCodexPlugin } from '../src/install-plugin.js';

/**
 * `resolveDevRepoRoot` is INJECTED: finding the user's source checkout reads the
 * running CLI's own path, which is the app's business, and an agent package must
 * not import `apps/cli`.
 *
 * That makes dropping it on the way through a silent failure — the dev
 * marketplace and the skill symlinks just stop happening, and every build and
 * typecheck still passes. Hence these.
 */
describe('codex plugin marketplace source', () => {
  it('uses the injected dev repo root when there is one', () => {
    expect(marketplaceSource({ resolveDevRepoRoot: () => '/repo/agentbox' })).toEqual({
      source: '/repo/agentbox',
      devRoot: '/repo/agentbox',
    });
  });

  it('falls back to the published GitHub slug with no checkout', () => {
    const r = marketplaceSource({ resolveDevRepoRoot: () => null });
    expect(r.devRoot).toBeNull();
    expect(r.source).toBe('madarco/agentbox');
  });

  it('honours --no-dev even inside a checkout', () => {
    const r = marketplaceSource({ noDev: true, resolveDevRepoRoot: () => '/repo/agentbox' });
    expect(r.devRoot).toBeNull();
    expect(r.source).toBe('madarco/agentbox');
  });

  it('treats an absent resolver as "no checkout" rather than throwing', () => {
    // A published install passes none at all.
    expect(marketplaceSource({}).devRoot).toBeNull();
  });

  it('threads the resolver through installCodexPlugin, not just noDev', async () => {
    // The regression this guards: `installCodexPlugin` forwarding only `noDev`
    // to `marketplaceSource`. Nothing observable breaks — the dev path just
    // silently stops — so assert the resolver is actually consulted.
    let asked = false;
    await installCodexPlugin({
      dryRun: true,
      quiet: true,
      resolveDevRepoRoot: () => {
        asked = true;
        return null;
      },
    });
    expect(asked).toBe(true);
  });
});
