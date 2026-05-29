import { defineConfig } from 'tsup';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8')) as { version: string };

function gitShortSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  dts: false,
  sourcemap: true,
  // Substituted at bundle time — see apps/cli/src/version.ts for the
  // matching `declare` lines that keep the unbundled typecheck honest.
  define: {
    __AGENTBOX_VERSION__: JSON.stringify(pkg.version),
    __AGENTBOX_COMMIT__: JSON.stringify(gitShortSha()),
  },
  // Published as the standalone `agent-box` npm package. Only the @agentbox/*
  // workspace libs are bundled (pure TS/ESM) so the package carries no
  // `workspace:*` deps. Every third-party dep stays external and is a real
  // installable `dependency` — notably execa/cross-spawn, which use dynamic
  // require('child_process') and break esbuild's ESM `__require` shim if
  // bundled. tsup externalizes anything in `dependencies`; the explicit list
  // also keeps esbuild from walking node-pty's prebuilt-binary path probing.
  external: [
    '@homebridge/node-pty-prebuilt-multiarch',
    '@xterm/headless',
    // @daytonaio/sdk pulls a heavy CJS tree (AWS S3 SDK, axios, dotenv, ...)
    // that uses dynamic `require()` — bundling it breaks esbuild's ESM
    // `__require` shim ("Dynamic require of 'util' is not supported"). Keep
    // it external; the published `agent-box` package lists it as a real dep.
    '@daytonaio/sdk',
    // @vercel/sandbox bundles undici, which uses dynamic `require('assert')`
    // etc. — same ESM `__require` breakage. External + real dep, like daytona.
    '@vercel/sandbox',
  ],
  noExternal: [/^@agentbox\//],
  banner: {
    js: '#!/usr/bin/env node',
  },
  // After the bundle is written, stage the on-disk runtime assets the bundled
  // CLI still needs as files (the spawned relay bin + the Docker build
  // context). Runs after `^build` so the sibling package dists exist.
  onSuccess: 'node scripts/stage-runtime.mjs',
});
