import { defineConfig } from 'vitest/config';

// Unit tests here are PURE (no docker, no network, no Next runtime): they exercise
// the presentation helpers in lib/ that shape custody + system data for the pages.
export default defineConfig({
  // The pages/components use Tailwind via PostCSS, but these unit tests import no
  // CSS — override PostCSS to an empty config so Vite doesn't try to load the
  // app's tailwind plugin (which fails outside the Next build).
  css: { postcss: { plugins: [] } },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
