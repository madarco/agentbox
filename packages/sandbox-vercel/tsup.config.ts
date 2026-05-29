import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries: the provider surface (`.`) and the CLI surface (`./cli`).
  // Interactive attach drives the external `sbx` CLI (real PTY) — see
  // build-attach.ts — so there's no standalone helper process to build.
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  dts: true,
  sourcemap: true,
  // commander + @clack/prompts are external (apps/cli bundles them at the root).
  // @vercel/sandbox is bundled by tsup as usual for sibling deps.
  external: ['commander', '@clack/prompts'],
});
