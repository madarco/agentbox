import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_SDK_API_VERSIONS } from '@agentbox/sandbox-core';

/**
 * The shipped provider examples must stay loadable by THIS build.
 *
 * `examples/` is outside `pnpm-workspace.yaml` (`apps/*`, `packages/*` only), so
 * nothing builds, typechecks or tests it — an SDK bump could refuse both
 * examples with the whole suite green. That is not hypothetical: the agent
 * example shipped with two defects for exactly this reason, and only a review
 * caught them.
 *
 * This is deliberately cheap — it reads the manifests rather than building the
 * packages, because building them needs their own `npm install`. It catches the
 * thing that actually breaks on a version bump: a declared `providerApiVersion`
 * the CLI no longer accepts, or an SDK dependency range that cannot resolve to
 * the version this repo now builds.
 */
const REPO = join(__dirname, '..', '..', '..');
const EXAMPLES = ['agentbox-provider-example', 'agentbox-provider-sample'];

function manifest(name: string): {
  agentbox?: { providerApiVersion?: number };
  dependencies?: Record<string, string>;
} {
  return JSON.parse(
    readFileSync(join(REPO, 'examples', name, 'package.json'), 'utf8'),
  ) as ReturnType<typeof manifest>;
}

const sdkVersion = (
  JSON.parse(readFileSync(join(REPO, 'packages', 'provider-sdk', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

describe('the SDK and the CLI agree on the contract version', () => {
  it("the SDK's own SDK_API_VERSION is one this build accepts", () => {
    // Two halves of one decision that live in different packages: the SDK
    // declares the version it implements, the CLI declares what it loads. Bump
    // one without the other and every plugin built on the new SDK is refused by
    // the CLI that shipped with it — which no other check catches, since
    // `pack:test` only validates the SDK side.
    const src = readFileSync(join(REPO, 'packages', 'provider-sdk', 'src', 'index.ts'), 'utf8');
    const declared = /export const SDK_API_VERSION = (\d+);/.exec(src)?.[1];
    expect(
      declared,
      'SDK_API_VERSION not found in the literal form pack-test also greps',
    ).toBeDefined();
    expect(
      SUPPORTED_SDK_API_VERSIONS.includes(Number(declared)),
      `the SDK implements v${String(declared)}, but this build loads ${SUPPORTED_SDK_API_VERSIONS.join(', ')}`,
    ).toBe(true);
  });

  it("the SDK package's major matches the contract version it declares", () => {
    // A major bump without an SDK_API_VERSION bump publishes a breaking change
    // that every CLI still happily loads.
    const src = readFileSync(join(REPO, 'packages', 'provider-sdk', 'src', 'index.ts'), 'utf8');
    const declared = /export const SDK_API_VERSION = (\d+);/.exec(src)?.[1];
    expect(sdkVersion.split('.')[0]).toBe(declared);
  });
});

describe('the shipped provider examples track the SDK', () => {
  it('has examples to check (the list itself can go stale)', () => {
    for (const name of EXAMPLES) {
      expect(existsSync(join(REPO, 'examples', name, 'package.json')), name).toBe(true);
    }
  });

  it('declares a providerApiVersion this build still accepts', () => {
    for (const name of EXAMPLES) {
      const declared = manifest(name).agentbox?.providerApiVersion;
      // `plugin add` reads package.json FIRST — it wins over the SDK's own
      // constant — so bumping only the dependency leaves the example refused.
      expect(declared, `${name} declares no providerApiVersion`).toBeDefined();
      expect(
        SUPPORTED_SDK_API_VERSIONS.includes(declared as number),
        `${name} declares providerApiVersion ${String(declared)}, but this build supports ${SUPPORTED_SDK_API_VERSIONS.join(', ')}`,
      ).toBe(true);
    }
  });

  it('pins an SDK range that admits the version this repo builds', () => {
    const major = sdkVersion.split('.')[0];
    for (const name of EXAMPLES) {
      const range = manifest(name).dependencies?.['@madarco/agentbox-provider-sdk'];
      expect(range, `${name} does not depend on the SDK`).toBeDefined();
      // A `file:` link always tracks the local build; a semver range must not
      // pin a major the repo has moved past.
      if (range!.startsWith('file:')) continue;
      expect(range, `${name} pins ${range!} but the SDK is now ${sdkVersion}`).toContain(major);
    }
  });
});
