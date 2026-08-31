import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries, and the split is load-bearing. `./spec` is DATA and must stay
  // importable by code that can never import an agent's behavior — the agent
  // registry that `sandbox-core` reads, and through it the relay and hub. It
  // therefore depends on `@agentbox/core` and nothing else; `agent-spec-purity`
  // in the repo test suite enforces that, because a stray import here becomes a
  // dependency cycle that may only surface in the published bundle.
  entry: ['src/index.ts', 'src/spec.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  dts: true,
  sourcemap: true,
});
