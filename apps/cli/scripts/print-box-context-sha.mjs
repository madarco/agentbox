#!/usr/bin/env node
/**
 * Print the docker build-context fingerprint (sha256) for the staged runtime
 * at `apps/cli/runtime/docker`. CI tags the published box image
 * `sha-<first 16 hex>` so the CLI's runtime pull target
 * (`registryRefForSha()` in @agentbox/sandbox-docker) matches the fingerprint
 * it computes locally — the tag *is* the content identity.
 *
 * Run AFTER `pnpm build` (which builds @agentbox/sandbox-core and stages the
 * runtime tree via apps/cli's tsup onSuccess). Mirrors `resolveContextFiles`
 * in packages/sandbox-docker/src/prepared-state.ts.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claudeInstallFingerprint,
  DOCKER_CONTEXT_FILE_MAP,
  resolveContextFilesFrom,
  computeContextSha256,
} from '@agentbox/sandbox-core';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..'); // apps/cli/scripts -> repo root
const contextDir = resolve(repoRoot, 'apps/cli/runtime/docker');
const devRoot = resolve(repoRoot, 'packages/sandbox-docker');

const files = resolveContextFilesFrom(DOCKER_CONTEXT_FILE_MAP, { contextDir, devRoot });
if (!files) {
  process.stderr.write(
    `error: could not resolve all docker context files under ${contextDir} (did you run \`pnpm build\`?)\n`,
  );
  process.exit(1);
}
// `--claude-install npm` prints the fingerprint of the NPM image variant.
// The install mode is part of the image's identity — the same context built with
// `AGENTBOX_CLAUDE_INSTALL=npm` is a different image — and the CLI asks for the
// folded sha (`claudeInstallFingerprint` in pullOrBuild). CI must publish under
// that same tag or npm-mode users never get a pull hit. `native` is the identity.
const modeIdx = process.argv.indexOf('--claude-install');
const mode = modeIdx === -1 ? 'native' : process.argv[modeIdx + 1];
if (mode !== 'native' && mode !== 'npm') {
  process.stderr.write(`error: --claude-install must be 'native' or 'npm' (got '${mode}')\n`);
  process.exit(1);
}

const sha = await computeContextSha256(files);
process.stdout.write(claudeInstallFingerprint(sha, mode) + '\n');
