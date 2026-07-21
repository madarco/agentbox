import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries: the provider surface (`.`) and the CLI surface (`./cli`).
  // Splitting keeps consumers that only want the provider from pulling
  // commander/clack into their type graph.
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  dts: true,
  sourcemap: true,
  // `@daytona/sdk` pulls in heavy server-side helpers — keep it external so
  // it's only resolved at runtime. `commander` and `@clack/prompts` are
  // marked external so apps/cli (which already bundles them at the root) does
  // not double-include them via its `noExternal: [/^@agentbox\//]` rule.
  external: ['@daytona/sdk', 'commander', '@clack/prompts'],
});
