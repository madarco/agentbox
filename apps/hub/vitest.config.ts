import { defineConfig } from 'vitest/config';

// Unit tests here are PURE (no docker, no network, no Next runtime): the pure
// presentation/logic helpers in `lib/` (project naming, seed/custody + system
// shaping) and their `test/` counterparts. Scoped to those two trees so vitest
// never tries to load a Next route/page module.
export default defineConfig({
  // The pages/components use Tailwind via PostCSS, but these unit tests import no
  // CSS — override PostCSS to an empty config so Vite never tries to load the
  // app's tailwind plugin (its plugin isn't a Vite plugin and fails outside the
  // Next build).
  css: { postcss: { plugins: [] } },
  test: {
    include: ['lib/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
