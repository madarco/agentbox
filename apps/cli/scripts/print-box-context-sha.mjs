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
// One sha, no variants. The published base is AGENTLESS, so no agent setting
// can change what it contains — this used to fold the Claude install mode and
// CI published two byte-identical images under two tags.
const sha = await computeContextSha256(files);
process.stdout.write(sha + '\n');
