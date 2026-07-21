import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeInstallFingerprint } from '@agentbox/sandbox-core';
import { describe, expect, it } from 'vitest';

/**
 * The publish workflow and the CLI must agree on what a box image is called.
 *
 * The install mode is part of the image's IDENTITY: the same context built with
 * `AGENTBOX_CLAUDE_INSTALL=npm` is a different image, and the CLI asks for a
 * correspondingly different tag (`claudeInstallFingerprint`, folded in
 * `pullOrBuild`). CI used to build only the default (native) variant, so
 * `box.claudeInstall: npm` users never got a pull hit — a wasted local build on
 * docker, and on daytona no VM at all, since a linux-vm base can only boot from
 * a *published* image.
 *
 * Nothing about that failure is loud: a missing tag just 404s and the CLI
 * quietly builds (or silently downgrades a VM to a container). Hence a test on
 * the wiring itself.
 */
const workflow = readFileSync(
  join(__dirname, '..', '..', '..', '.github', 'workflows', 'box-image.yml'),
  'utf8',
);

describe('box-image workflow', () => {
  it('publishes both install variants', () => {
    expect(workflow).toMatch(/claude-install:\s*\[native,\s*npm\]/);
  });

  it('actually builds the variant it names (the build-arg the Dockerfile reads)', () => {
    // Without this the npm job would rebuild the *native* image and publish it
    // under the npm tag — worse than not publishing it at all.
    expect(workflow).toMatch(/AGENTBOX_CLAUDE_INSTALL=\$\{\{\s*matrix\.claude-install\s*\}\}/);
  });

  it('tags each variant with ITS OWN fingerprint', () => {
    // The sha must be computed per-variant, or both jobs would publish under the
    // native tag and race each other.
    expect(workflow).toMatch(
      /print-box-context-sha\.mjs --claude-install \$\{\{\s*matrix\.claude-install\s*\}\}/,
    );
  });

  it('lets only the native build claim `latest` and the version tag', () => {
    // Those two name the DEFAULT image. If the npm job could move `latest`,
    // every default user would get an npm-installed Claude.
    expect(workflow).toMatch(/if \[ "\$\{\{ matrix\.claude-install \}\}" = "native" \]/);
    expect(workflow).toMatch(/matrix\.claude-install == 'native'/);
  });

  it('has no paths filter — ctl inlines its deps, so any of them can shift the sha', () => {
    expect(workflow).not.toMatch(/^\s*paths:/m);
  });
});

describe('the tag CI publishes is the tag the CLI resolves', () => {
  it('folds the install mode the same way on both sides', () => {
    const base = 'a'.repeat(64);
    // `native` is the identity — the historical tag keeps resolving.
    expect(claudeInstallFingerprint(base, 'native')).toBe(base);
    // `npm` is a distinct image, so a distinct tag.
    expect(claudeInstallFingerprint(base, 'npm')).not.toBe(base);
    // Stable: CI and the CLI compute it independently, from the same helper.
    expect(claudeInstallFingerprint(base, 'npm')).toBe(claudeInstallFingerprint(base, 'npm'));
  });
});
