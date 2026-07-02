import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  // `resolve: [/^@agentbox\//]` makes rollup-plugin-dts follow and INLINE the
  // declaration types of the inlined @agentbox packages (without it, tsup only
  // re-exports `… from '@agentbox/core'`, which a plugin can't resolve since
  // those packages are private/unpublished). execa/yaml type imports stay external.
  dts: { resolve: [/^@agentbox\//] },
  sourcemap: true,
  // Inline every @agentbox/* workspace package (core, config, sandbox-core,
  // sandbox-cloud and their private transitive graph — sandbox-docker/ctl/relay)
  // so the published SDK is self-contained and carries NO @agentbox deps. Same
  // trick apps/cli uses. Third-party runtime deps (execa/yaml/smol-toml) stay
  // external and are declared as real dependencies; `pg` is external and unlisted
  // — it's only reached by the relay's PostgresStore via a lazy `import('pg')`
  // that a provider plugin never hits, so it must never be bundled.
  noExternal: [/^@agentbox\//],
  external: ['pg'],
});
