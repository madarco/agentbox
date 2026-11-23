import { defineConfig } from 'tsup';

// Two builds:
//   - `src/index.ts` + `src/cli.ts` (ESM): the provider surface (`.`) and the CLI
//     surface (`./cli`).
//   - `src/exec-helper.ts` (CJS bundle): the standalone process `buildVercelAttach`
//     spawns for the detached agent start and `logs`, which run on the in-process
//     SDK instead of the host's `sbx`. CJS because it is invoked as `node <path>`
//     with no package `type` hint. The interactive PTY attach still drives `sbx`.
export default defineConfig([
  {
    entry: ['src/index.ts', 'src/cli.ts'],
    format: ['esm'],
    target: 'node20',
    // tsup runs the two configs concurrently, so a clean here could delete the
    // helper the other build just wrote. `pnpm build` empties dist/ first.
    clean: false,
    dts: true,
    sourcemap: true,
    // commander + @clack/prompts are external (apps/cli bundles them at the root).
    // @vercel/sandbox is bundled by tsup as usual for sibling deps.
    external: ['commander', '@clack/prompts'],
  },
  {
    entry: { 'exec-helper': 'src/exec-helper.ts' },
    format: ['cjs'],
    target: 'node20',
    clean: false,
    dts: false,
    sourcemap: true,
    // Resolved from the host install (apps/cli and apps/hub list it as a real
    // dep), the same way the E2B attach helper resolves `e2b`.
    external: ['@vercel/sandbox'],
  },
]);
