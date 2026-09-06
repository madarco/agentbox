import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `runtime/` is gitignored build output: stage-runtime.mjs copies the hub
    // bundle (tests included) in on every CLI build. Vitest's default include
    // sweeps it, so a stale staging — `pnpm build` does not regenerate
    // apps/hub/dist-standalone, which is what runtime/hub is copied from —
    // fails `pnpm test` with errors that no longer exist in any source file.
    // Tests must run against sources, never against a build artifact.
    exclude: [...configDefaults.exclude, 'runtime/**'],
  },
});
