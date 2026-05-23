import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  dts: true,
  sourcemap: true,
  // @daytonaio/sdk pulls in heavy server-side helpers; keep it external so the
  // bundled CLI doesn't carry it inside dist/index.js (it's still resolved at
  // runtime via node_modules).
  external: ['@daytonaio/sdk'],
});
