import { defineConfig } from 'vitest/config';

// Unit tests for the hub's pure logic only (project naming, seed status shaping).
// Kept scoped to `lib/**` so vitest never tries to load Next route/page modules.
export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts'],
    environment: 'node',
  },
});
