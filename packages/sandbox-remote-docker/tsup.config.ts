import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries, as in the sibling providers: the provider surface (`.`) and
  // the CLI surface (`./cli`).
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  dts: true,
  sourcemap: true,
  external: ['commander', '@clack/prompts'],
});
