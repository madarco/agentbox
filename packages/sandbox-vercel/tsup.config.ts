import { defineConfig } from 'tsup';

export default defineConfig({
  // Three entries: the provider surface (`.`), the CLI surface (`./cli`), and
  // the standalone attach-helper (a host-side process the PTY wrapper spawns to
  // pump stdio through the Vercel SDK — Vercel has no SSH, so attach can't be a
  // plain `ssh` argv like daytona/hetzner).
  entry: ['src/index.ts', 'src/cli.ts', 'src/attach-helper.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  dts: true,
  sourcemap: true,
  // commander + @clack/prompts are external (apps/cli bundles them at the root).
  // @vercel/sandbox is bundled by tsup as usual for sibling deps.
  external: ['commander', '@clack/prompts'],
});
