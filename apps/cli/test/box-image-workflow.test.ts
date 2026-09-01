import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The publish workflow and the CLI must agree on what a box image is called.
 *
 * There is exactly ONE image per build context, because the published base is
 * AGENTLESS: it installs no agent, so no agent setting can change what it
 * contains. This used to matrix over the Claude install mode and publish two
 * byte-identical images under two tags — a build arg the Dockerfile declared
 * and no `RUN` ever read.
 *
 * Nothing about a tag mismatch is loud: a missing tag just 404s and the CLI
 * quietly builds (or silently downgrades a daytona VM to a container, since a
 * linux-vm base can only boot from a *published* image). Hence a test on the
 * wiring itself.
 */
const workflow = readFileSync(
  join(__dirname, '..', '..', '..', '.github', 'workflows', 'box-image.yml'),
  'utf8',
);

describe('box-image workflow', () => {
  it('publishes one image per context, with no per-agent variant axis', () => {
    expect(workflow).not.toMatch(/claude-install/);
    expect(workflow).not.toMatch(/AGENTBOX_CLAUDE_INSTALL/);
    expect(workflow).not.toMatch(/^\s*matrix:/m);
  });

  it('tags it with the fingerprint the CLI computes', () => {
    expect(workflow).toMatch(/print-box-context-sha\.mjs/);
    expect(workflow).toMatch(/\$IMAGE:sha-\$\{SHA:0:16\}/);
  });

  it('lets only a release ref claim `latest` and the version tag', () => {
    // Those two name the STABLE image; a nightly moving them would ship
    // unreleased code to every default user.
    expect(workflow).toMatch(/if \[ "\$RELEASE_REF" = "true" \]/);
    expect(workflow).toMatch(/steps\.tags\.outputs\.release_ref == 'true'/);
  });

  it('has no paths filter — ctl inlines its deps, so any of them can shift the sha', () => {
    expect(workflow).not.toMatch(/^\s*paths:/m);
  });
});

describe('the agentless base carries no agent setting', () => {
  it('declares no per-agent build arg in the Dockerfile', async () => {
    // A build arg for an agent setting here would fork the shared base and the
    // published GHCR tag without changing a byte, because this image runs no
    // install recipe. The settings reach the DERIVED layer instead.
    const dockerfile = readFileSync(
      join(__dirname, '..', '..', '..', 'packages', 'sandbox-docker', 'Dockerfile.box'),
      'utf8',
    );
    const args = [...dockerfile.matchAll(/^ARG\s+(\w+)/gm)].map((m) => m[1]);
    expect(args).not.toContain('AGENTBOX_CLAUDE_INSTALL');
    expect(args.filter((a) => a?.startsWith('AGENTBOX_AGENT_SETTING_'))).toEqual([]);
  });

  it('folds nothing into the base fingerprint', async () => {
    const { variantFingerprint } = await import('@agentbox/sandbox-core');
    const base = 'a'.repeat(64);
    // The empty variant is the identity, so the historical tag keeps resolving.
    expect(variantFingerprint(base)).toBe(base);
    expect(variantFingerprint(base, { agentSettings: { claude: { install: 'npm' } } })).not.toBe(
      base,
    );
  });
});
