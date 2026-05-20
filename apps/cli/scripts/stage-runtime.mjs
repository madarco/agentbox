// Stage the on-disk runtime assets the bundled `agent-box` CLI needs as files.
//
// The CLI bundle (dist/index.js) is self-contained JS, but two things still
// have to exist on disk at runtime and cannot be bundled:
//
//   1. the host relay bin — spawned as a separate `node <bin> serve` process
//      (packages/sandbox-docker/src/relay.ts resolveRelayBin()).
//   2. the Docker build context — `docker build -f Dockerfile.box <context>`,
//      whose COPY lines reference packages/ctl/dist/bin.cjs,
//      apps/cli/share/..., packages/sandbox-docker/scripts/* by their
//      monorepo-relative paths.
//
// We mirror those exact relative paths under runtime/docker/ so Dockerfile.box
// needs zero changes. runtime/ sits next to dist/ in both the dev tree and the
// published package, so the resolvers anchor on it uniformly.

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(scriptDir, '..'); // apps/cli
const repoRoot = resolve(cliRoot, '..', '..'); // monorepo root
const runtime = join(cliRoot, 'runtime');
const dockerCtx = join(runtime, 'docker');

// Copies that land directly under runtime/ (not part of the docker context).
const direct = [
  ['packages/relay/dist/bin.cjs', 'relay/bin.cjs'],
];

// Copies that reproduce the EXACT monorepo-relative path the Dockerfile.box
// COPY statements use, rooted at runtime/docker/ (the build context).
const dockerfileSrc = 'packages/sandbox-docker/Dockerfile.box';
const execBitFiles = new Set([
  'packages/sandbox-docker/scripts/agentbox-vnc-start',
  'packages/sandbox-docker/scripts/agentbox-dockerd-start',
  'packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup',
]);
const contextFiles = [
  'packages/ctl/dist/bin.cjs',
  'apps/cli/share/agentbox-setup/SKILL.md',
  'packages/sandbox-docker/scripts/agentbox-vnc-start',
  'packages/sandbox-docker/scripts/agentbox-dockerd-start',
  'packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup',
  'packages/sandbox-docker/scripts/custom-system-CLAUDE.md',
  'packages/sandbox-docker/scripts/claude-managed-settings.json',
];

let missing = 0;
function copy(srcRel, destAbs, exec = false) {
  const src = join(repoRoot, srcRel);
  if (!existsSync(src)) {
    console.warn(`[stage-runtime] WARN missing source (skipped): ${srcRel}`);
    missing++;
    return;
  }
  mkdirSync(dirname(destAbs), { recursive: true });
  cpSync(src, destAbs, { recursive: true });
  if (exec) chmodSync(destAbs, 0o755);
}

rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });

for (const [srcRel, destRel] of direct) {
  copy(srcRel, join(runtime, destRel));
}
copy(dockerfileSrc, join(dockerCtx, 'Dockerfile.box'));
for (const srcRel of contextFiles) {
  copy(srcRel, join(dockerCtx, srcRel), execBitFiles.has(srcRel));
}

if (missing > 0) {
  console.warn(
    `[stage-runtime] ${missing} asset(s) missing — fine in a partial dev rebuild, ` +
      `but a publish must run a full \`pnpm -w build\` first (prepublishOnly does).`,
  );
} else {
  console.log('[stage-runtime] staged runtime/ (relay bin + docker build context)');
}
