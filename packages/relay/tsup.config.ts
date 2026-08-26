import { defineConfig } from 'tsup';

// Same two-output pattern as @agentbox/ctl:
//   dist/index.js — library entry consumed by other workspace packages.
//   dist/bin.cjs  — self-contained CJS bin baked into the relay docker image.
//
// Runtime contract: the `@agentbox/sandbox-*` packages are NOT in this bundle.
// Keeping them out avoids
//   1. a `relay → sandbox-{daytona,cloud} → sandbox-docker → relay`
//      dependency cycle in package.json declarations,
//   2. eager loading of the heavy Daytona SDK CJS tree in box-mode relays
//      that never touch cloud,
//   3. bloating relay/bin.cjs with code only the host relay ever uses.
//
// Instead the host process INJECTS them: `setCloudBackendLoader` (see the long
// note on `resolveCloudBackend` in src/host-actions.ts). The CLI's relay bin
// side-loads `apps/cli/dist/cloud-backends.js` via AGENTBOX_CLOUD_BACKENDS; the
// hub registers its own map in-process. The `import()`-by-computed-specifier
// fallback in host-actions.ts only ever resolves in the pnpm dev tree — an npm
// install has no `@agentbox/*` in node_modules at all, which is exactly the bug
// the injection fixed.
const externalAtRuntime = [
  '@agentbox/sandbox-daytona',
  '@agentbox/sandbox-cloud',
  '@daytona/sdk',
  // `pg` is only used by the Postgres store on the hosted control plane, loaded
  // via a lazy dynamic `import('pg')`. Keep it out of both relay bundles (esp.
  // the self-contained bin.cjs) so the laptop relay never carries it.
  // (The SQLite store's driver is `node:sqlite`, a builtin — external by
  // definition — and is likewise only imported lazily, so a Node < 22.5 host
  // never touches it unless it asks for a SQLite store.)
  'pg',
];

export default defineConfig([
  {
    // `index` is the full library (consumed by the CLI / sandbox packages).
    // `control-plane` is the lean hosted-plane entry (the Next.js app) — no
    // server.ts/host-actions, so its graph carries none of the cloud SDKs.
    entry: {
      index: 'src/index.ts',
      'control-plane': 'src/control-plane.ts',
      daemon: 'src/daemon.ts',
    },
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
