/**
 * Root vitest workspace.
 *
 * Without this file, `vitest` run from the repo root discovers every package's
 * tests under ONE implicit root config and silently drops each package's own
 * `vitest.config.ts` — including its `setupFiles`.
 *
 * That is not cosmetic. `packages/config`'s suites import the HOME-derived
 * constants STATICALLY (GLOBAL_CONFIG_FILE, PROJECTS_DIR), so the only place
 * that can relocate `$HOME` in time is a setup file. Drop it and those suites
 * run against the real home — and their `afterEach` deletes `$HOME/.agentbox`,
 * taking secrets.env, state.json and the hub token with it.
 *
 * `pnpm test` (turbo → per-package `vitest`) always loaded those configs; this
 * makes a root-level `pnpm vitest run` behave identically. `assertTempHome` in
 * `scripts/test-home.ts` is the backstop that fails loudly rather than deleting
 * if this wiring is ever broken again.
 */
export default ['packages/*', 'apps/cli', 'apps/hub'];
