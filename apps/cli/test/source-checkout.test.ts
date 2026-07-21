import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isSourceCheckout, resolveDevRepoRoot } from '../src/lib/source-checkout.js';

describe('isSourceCheckout', () => {
  it('is false for any path under node_modules (every distribution path)', () => {
    expect(isSourceCheckout('/Users/x/node_modules/@madarco/agentbox/share/host-skills')).toBe(
      false,
    );
    expect(isSourceCheckout('/opt/pnpm/global/5/node_modules/.pnpm/x/share')).toBe(false);
  });

  it('is true for a source clone (no node_modules segment)', () => {
    expect(isSourceCheckout('/Users/x/Projects/agentbox/apps/cli/share/host-skills')).toBe(true);
  });
});

describe('resolveDevRepoRoot', () => {
  // The test process itself runs from the source checkout, so this exercises the
  // real dev branch: it must return the repo root that carries the Codex sources.
  it('returns the repo root carrying the Codex marketplace + plugin', () => {
    const root = resolveDevRepoRoot();
    expect(root).not.toBeNull();
    expect(existsSync(join(root!, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
    expect(existsSync(join(root!, 'plugins', 'agentbox', '.codex-plugin', 'plugin.json'))).toBe(
      true,
    );
  });
});
