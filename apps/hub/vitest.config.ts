import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Vite 5 cannot load `node:sqlite` (a prefix-only builtin — see the shim's own
// comment), which `lib/auth.ts` needs for the embedded profiles. Alias both the
// prefixed and the vite-stripped spelling to a shim that `createRequire`s the
// real builtin at runtime.
const NODE_SQLITE_SHIM = fileURLToPath(new URL('./test/_node-sqlite-shim.ts', import.meta.url));

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
    setupFiles: ['./test/setup.ts'],
    alias: { 'node:sqlite': NODE_SQLITE_SHIM, sqlite: NODE_SQLITE_SHIM },
  },
});
