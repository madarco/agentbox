import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries mirror the daytona package: the provider surface (`.`) and
  // the CLI surface (`./cli`). Splitting keeps consumers that only want the
  // provider from pulling commander/clack into their type graph.
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  dts: true,
  sourcemap: true,
  // commander + @clack/prompts are marked external so apps/cli (which bundles
  // them at the root) doesn't double-include them via its
  // `noExternal: [/^@agentbox\//]` rule. execa is bundled by tsup as is its
  // normal pattern in sibling packages.
  external: ['commander', '@clack/prompts'],
});
