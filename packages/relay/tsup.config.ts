import { defineConfig } from 'tsup';

// Same two-output pattern as @agentbox/ctl:
//   dist/index.js — library entry consumed by other workspace packages.
//   dist/bin.cjs  — self-contained CJS bin baked into the relay docker image.
//
// `@agentbox/sandbox-daytona` (and its `@daytonaio/sdk` dep) are resolved at
// runtime via dynamic `import()` — host-actions.ts only needs them when a
// cloud box is registered. Mark external on both targets so esbuild doesn't
// try to inline them at build time and so the heavy SDK CJS tree doesn't end
// up in the relay bundle.
const externalAtRuntime = ['@agentbox/sandbox-daytona', '@daytonaio/sdk'];

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node20',
    clean: true,
    dts: true,
    sourcemap: true,
    external: externalAtRuntime,
  },
  {
    entry: { bin: 'src/bin.ts' },
    format: ['cjs'],
    target: 'node20',
    clean: false,
    dts: false,
    sourcemap: false,
    noExternal: [/.*/],
    external: externalAtRuntime,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
]);
