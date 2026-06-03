import { defineConfig } from 'tsup';

// Three entries:
//   - `src/index.ts` (ESM) — provider surface consumed by apps/cli.
//   - `src/cli.ts`   (ESM) — `agentbox e2b login` subcommand.
//   - `src/attach-helper.ts` (CJS bundle) — standalone Node process spawned
//     by `buildE2bAttach` to bridge the host PTY → an in-box SDK PTY. CJS
//     because it's invoked via `node <path>` (no package-level type:module
//     hint reaches a standalone .js); bundling lets us ship one file.
export default defineConfig([
  {
    entry: ['src/index.ts', 'src/cli.ts'],
    format: ['esm'],
    target: 'node20',
    clean: true,
    dts: true,
    sourcemap: true,
    // commander + @clack/prompts are external (apps/cli bundles them at the root).
    // The `e2b` SDK is external too: its TemplateBuilder calls
    // `dynamicRequire('node:url')` in its constructor, which esbuild's ESM
    // `__require` shim throws on if bundled. Keep it external + a real dep so
    // the SDK loads via the host's normal CJS require.
    external: ['commander', '@clack/prompts', 'e2b'],
  },
  {
    entry: { 'attach-helper': 'src/attach-helper.ts' },
    format: ['cjs'],
    target: 'node20',
    // Don't clean — the ESM build above already cleaned dist/.
    clean: false,
    // No d.ts for the standalone helper.
    dts: false,
    sourcemap: true,
    // Same externals. The attach helper is CJS, so the require path is
    // already native — but pinning `e2b` external keeps the bundle small.
    external: ['commander', '@clack/prompts', 'e2b'],
  },
]);
