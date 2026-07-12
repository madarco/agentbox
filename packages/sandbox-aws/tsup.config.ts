import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries mirror the sibling cloud packages: the provider surface (`.`)
  // and the CLI surface (`./cli`). Splitting keeps consumers that only want the
  // provider from pulling commander/clack into their type graph.
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  dts: true,
  sourcemap: true,
  // commander + @clack/prompts are marked external so apps/cli (which bundles
  // them at the root) doesn't double-include them via its
  // `noExternal: [/^@agentbox\//]` rule. `@aws-sdk/client-ec2` is external too:
  // it is a heavy dep tree and apps/cli declares it directly (same treatment as
  // @daytonaio/sdk / e2b / @vercel/sandbox), so bundling it here would duplicate
  // it into every consumer.
  external: ['commander', '@clack/prompts', '@aws-sdk/client-ec2'],
});
