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

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(scriptDir, '..'); // apps/cli
const repoRoot = resolve(cliRoot, '..', '..'); // monorepo root
const runtime = join(cliRoot, 'runtime');
const dockerCtx = join(runtime, 'docker');
const hetznerCtx = join(runtime, 'hetzner');
const daytonaCtx = join(runtime, 'daytona');
const vercelCtx = join(runtime, 'vercel');
const e2bCtx = join(runtime, 'e2b');

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
  'packages/sandbox-docker/scripts/agentbox-open',
  'packages/sandbox-docker/scripts/gh-shim',
  'packages/sandbox-docker/scripts/git-shim',
  'packages/sandbox-docker/scripts/ntn-shim',
  'packages/sandbox-docker/scripts/linear-shim',
  'packages/sandbox-docker/scripts/chromium-resolver',
]);
const contextFiles = [
  'packages/ctl/dist/bin.cjs',
  'apps/cli/share/agentbox-setup/SKILL.md',
  'packages/sandbox-docker/scripts/agentbox-vnc-start',
  'packages/sandbox-docker/scripts/agentbox-dockerd-start',
  'packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup',
  'packages/sandbox-docker/scripts/agentbox-open',
  'packages/sandbox-docker/scripts/gh-shim',
  'packages/sandbox-docker/scripts/git-shim',
  'packages/sandbox-docker/scripts/ntn-shim',
  'packages/sandbox-docker/scripts/linear-shim',
  'packages/sandbox-docker/scripts/chromium-resolver',
  'packages/sandbox-docker/scripts/custom-system-CLAUDE.md',
  'packages/sandbox-docker/scripts/claude-managed-settings.json',
  'packages/sandbox-docker/scripts/agentbox-codex-hooks.json',
  'packages/sandbox-docker/scripts/opencode-agentbox-plugin.js',
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

// Hetzner provider — flat list of files mirroring the basenames the
// `packages/sandbox-hetzner/src/runtime-assets.ts` resolver looks for. We
// drop them at runtime/hetzner/<basename> so the resolver only needs one
// candidate per asset in the published-CLI path.
const hetznerFiles = [
  ['packages/sandbox-hetzner/scripts/install-box.sh', 'scripts/install-box.sh', true],
  ['packages/ctl/dist/bin.cjs', 'ctl.cjs', true],
  ['packages/sandbox-docker/scripts/agentbox-vnc-start', 'agentbox-vnc-start', true],
  ['packages/sandbox-docker/scripts/agentbox-dockerd-start', 'agentbox-dockerd-start', true],
  ['packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup', 'agentbox-checkpoint-cleanup', true],
  ['packages/sandbox-docker/scripts/agentbox-open', 'agentbox-open', true],
  ['packages/sandbox-docker/scripts/gh-shim', 'gh-shim', true],
  ['packages/sandbox-docker/scripts/git-shim', 'git-shim', true],
  ['packages/sandbox-docker/scripts/ntn-shim', 'ntn-shim', true],
  ['packages/sandbox-docker/scripts/linear-shim', 'linear-shim', true],
  ['packages/sandbox-hetzner/scripts/custom-system-CLAUDE.md', 'custom-system-CLAUDE.md', false],
  ['packages/sandbox-docker/scripts/claude-managed-settings.json', 'claude-managed-settings.json', false],
  ['packages/sandbox-docker/scripts/agentbox-codex-hooks.json', 'agentbox-codex-hooks.json', false],
  ['packages/sandbox-docker/scripts/opencode-agentbox-plugin.js', 'opencode-agentbox-plugin.js', false],
  ['apps/cli/share/agentbox-setup/SKILL.md', 'agentbox-setup-skill.md', false],
];
for (const [srcRel, destRel, exec] of hetznerFiles) {
  copy(srcRel, join(hetznerCtx, destRel), exec);
}

// Daytona provider — overlay files the daytona prepare step adds on top of
// Dockerfile.box via Image.addLocalFile(). Resolver lives at
// `packages/sandbox-daytona/src/dockerfile-context.ts` and looks for these
// under `<cliRoot>/runtime/daytona/<basename>`.
const daytonaFiles = [
  ['packages/sandbox-daytona/scripts/custom-system-CLAUDE.md', 'custom-system-CLAUDE.md', false],
];
for (const [srcRel, destRel, exec] of daytonaFiles) {
  copy(srcRel, join(daytonaCtx, destRel), exec);
}

// Vercel provider — assets uploaded into a fresh sandbox during `prepareVercel`
// (resolved by packages/sandbox-vercel/src/runtime-assets.ts under
// runtime/vercel/<...>). The vercel package is bundled into dist/index.js, so
// unlike the monorepo its dist/ isn't shipped — stage these explicitly.
// provision.sh lands at runtime/vercel/scripts/provision.sh because
// findStagedCliRuntimeRoot() anchors on that path. (Interactive attach uses the
// external `sbx` CLI now, so there's no attach-helper bundle to stage.)
const vercelFiles = [
  ['packages/sandbox-vercel/scripts/provision.sh', 'scripts/provision.sh', true],
  ['packages/ctl/dist/bin.cjs', 'ctl.cjs', true],
  ['packages/sandbox-docker/scripts/agentbox-vnc-start', 'agentbox-vnc-start', true],
  ['packages/sandbox-docker/scripts/agentbox-dockerd-start', 'agentbox-dockerd-start', true],
  ['packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup', 'agentbox-checkpoint-cleanup', true],
  ['packages/sandbox-docker/scripts/agentbox-open', 'agentbox-open', true],
  ['packages/sandbox-docker/scripts/gh-shim', 'gh-shim', true],
  ['packages/sandbox-docker/scripts/git-shim', 'git-shim', true],
  ['packages/sandbox-docker/scripts/ntn-shim', 'ntn-shim', true],
  ['packages/sandbox-docker/scripts/linear-shim', 'linear-shim', true],
  ['packages/sandbox-vercel/scripts/custom-system-CLAUDE.md', 'custom-system-CLAUDE.md', false],
  ['packages/sandbox-docker/scripts/claude-managed-settings.json', 'claude-managed-settings.json', false],
  ['packages/sandbox-docker/scripts/agentbox-codex-hooks.json', 'agentbox-codex-hooks.json', false],
  ['apps/cli/share/agentbox-setup/SKILL.md', 'agentbox-setup-skill.md', false],
];
for (const [srcRel, destRel, exec] of vercelFiles) {
  copy(srcRel, join(vercelCtx, destRel), exec);
}

// E2B provider — assets uploaded during Template.build via `template.copy`
// (resolved by packages/sandbox-e2b/src/runtime-assets.ts under
// runtime/e2b/<...>) + the PTY attach helper bundle the provider's
// `buildAttach` spawns at runtime. The e2b package is bundled into
// dist/index.js, so unlike the monorepo its dist/ isn't shipped — stage these
// explicitly. build-template.sh lands at runtime/e2b/scripts/build-template.sh
// because findStagedCliRuntimeRoot() anchors on that path.
const e2bFiles = [
  ['packages/sandbox-e2b/scripts/build-template.sh', 'scripts/build-template.sh', true],
  ['packages/sandbox-e2b/dist/attach-helper.cjs', 'attach-helper.cjs', false],
  ['packages/ctl/dist/bin.cjs', 'ctl.cjs', true],
  ['packages/sandbox-docker/scripts/agentbox-dockerd-start', 'agentbox-dockerd-start', true],
  ['packages/sandbox-docker/scripts/agentbox-vnc-start', 'agentbox-vnc-start', true],
  ['packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup', 'agentbox-checkpoint-cleanup', true],
  ['packages/sandbox-docker/scripts/agentbox-open', 'agentbox-open', true],
  ['packages/sandbox-docker/scripts/gh-shim', 'gh-shim', true],
  ['packages/sandbox-docker/scripts/git-shim', 'git-shim', true],
  ['packages/sandbox-docker/scripts/ntn-shim', 'ntn-shim', true],
  ['packages/sandbox-docker/scripts/linear-shim', 'linear-shim', true],
  ['packages/sandbox-e2b/scripts/custom-system-CLAUDE.md', 'custom-system-CLAUDE.md', false],
  ['packages/sandbox-docker/scripts/claude-managed-settings.json', 'claude-managed-settings.json', false],
  ['packages/sandbox-docker/scripts/agentbox-codex-hooks.json', 'agentbox-codex-hooks.json', false],
  ['apps/cli/share/agentbox-setup/SKILL.md', 'agentbox-setup-skill.md', false],
];
for (const [srcRel, destRel, exec] of e2bFiles) {
  copy(srcRel, join(e2bCtx, destRel), exec);
}

// Tenki provider — the only on-disk asset is the PTY attach helper bundle the
// provider's `buildAttach` spawns at runtime (`node attach-helper.cjs`). Boxes
// boot from a prepared Tenki registry image, so unlike docker/e2b there is no
// build context or shim tree to stage. The tenki package is bundled into
// dist/index.js (its dist/ isn't shipped), so stage the helper explicitly to
// runtime/tenki/attach-helper.cjs where resolveAttachHelperPath() looks.
const tenkiCtx = join(runtime, 'tenki');
const tenkiFiles = [['packages/sandbox-tenki/dist/attach-helper.cjs', 'attach-helper.cjs', false]];
for (const [srcRel, destRel, exec] of tenkiFiles) {
  copy(srcRel, join(tenkiCtx, destRel), exec);
}

// README — npm reads the published package's README only from the package
// root (apps/cli/), and there's no package.json field to point elsewhere.
// Mirror the repo-root README here so npmjs.com has a landing page, rewriting
// relative links to absolute GitHub URLs: the package's repository.directory
// is apps/cli, so `./docs/cover.jpg` would resolve to a non-existent path.
function stageReadme() {
  const src = join(repoRoot, 'README.md');
  if (!existsSync(src)) {
    console.warn('[stage-runtime] WARN missing source (skipped): README.md');
    missing++;
    return;
  }
  const raw = 'https://raw.githubusercontent.com/madarco/agentbox/main/';
  const blob = 'https://github.com/madarco/agentbox/blob/main/';
  const isImage = (p) => /\.(png|jpe?g|gif|svg|webp)(#.*)?$/i.test(p);
  const absolutize = (p) => (isImage(p) ? raw : blob) + p.replace(/^\.\//, '');
  const rewritten = readFileSync(src, 'utf8')
    .replace(/(\]\()(\.\/[^)]+)(\))/g, (_, a, p, b) => a + absolutize(p) + b)
    .replace(/((?:src|href)=")(\.\/[^"]+)(")/g, (_, a, p, b) => a + absolutize(p) + b);
  writeFileSync(join(cliRoot, 'README.md'), rewritten);
}
stageReadme();

if (missing > 0) {
  console.warn(
    `[stage-runtime] ${missing} asset(s) missing — fine in a partial dev rebuild, ` +
      `but a publish must run a full \`pnpm -w build\` first (prepublishOnly does).`,
  );
} else {
  console.log(
    '[stage-runtime] staged runtime/ (relay bin + docker build context + hetzner install assets + daytona overlay + vercel assets + e2b assets + tenki attach helper)',
  );
}
