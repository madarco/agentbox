import { defineConfig } from 'vitest/config';

// Unit tests for the hub's pure logic only (project naming, seed status shaping).
// Kept scoped to `lib/**` so vitest never tries to load Next route/page modules.
export default defineConfig({
  // The tests import no CSS; skip Vite's PostCSS discovery so it never tries to
  // load the app's Tailwind `postcss.config.mjs` (its plugin isn't a Vite plugin).
  css: { postcss: { plugins: [] } },
  test: {
    include: ['lib/**/*.test.ts'],
    environment: 'node',
  },
});
