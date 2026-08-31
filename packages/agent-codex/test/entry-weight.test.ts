import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The main entry of an agent package is imported by `sandbox-docker`'s module
 * registry, which the **hub** bundles. `@agentbox/cli-kit` carries the pty
 * backend, so anything reaching cli-kit from this entry fails the hub's esbuild
 * bundle on a `.node` binary — a failure that appears in a different app, in a
 * build step most changes never run.
 *
 * That is exactly what re-exporting the plugin installer from `src/index.ts`
 * did. It belongs on the `./cli` subpath, where the CLI (which already has
 * cli-kit) is the only consumer. Source-level because the symptom is a bundler
 * error three packages away, not a behaviour a unit test could catch.
 */
describe('agent-codex main entry stays bundler-cheap', () => {
  const main = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');

  it('does not reach @agentbox/cli-kit', () => {
    const importsKit = main
      .split('\n')
      .some((l) => /^\s*(import|export)\b/.test(l) && l.includes('@agentbox/cli-kit'));
    expect(importsKit, 'put it on the ./cli subpath instead').toBe(false);
  });

  it('does not re-export the plugin installer', () => {
    expect(main).not.toContain('install-plugin.js');
  });
});
