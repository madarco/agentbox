import { defineConfig } from 'tsup';

// Same two-output pattern as @agentbox/ctl:
//   dist/index.js — library entry consumed by other workspace packages.
//   dist/bin.cjs  — self-contained CJS bin baked into the relay docker image.
//
// Runtime contract: `@agentbox/sandbox-daytona` and `@agentbox/sandbox-cloud`
// (and their transitive `@daytonaio/sdk`) are resolved at runtime via
// dynamic `import()` from host-actions.ts. Both are excluded from the
// relay bundle here to avoid:
//   1. a `relay → sandbox-{daytona,cloud} → sandbox-docker → relay`
//      dependency cycle in package.json declarations,
//   2. eager loading of the heavy Daytona SDK CJS tree in box-mode relays
//      that never touch cloud,
//   3. bloating relay/bin.cjs with code only the host relay ever uses.
//
// The runtime owner (the `@madarco/agentbox` CLI) MUST make these packages
// resolvable from `node_modules` next to the relay bin. The CLI's own
// `tsup` config uses `noExternal: [/^@agentbox\//]` and the published
// `agent-box` npm package ships them inlined. See the long note on
// `resolveCloudBackend` in src/host-actions.ts for the full story.
const externalAtRuntime = [
  '@agentbox/sandbox-daytona',
  '@agentbox/sandbox-cloud',
  '@daytonaio/sdk',
];

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
