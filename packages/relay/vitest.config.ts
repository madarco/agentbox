import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A few suites are timing-sensitive: the block-mode prompt tests poll a
    // short window for an async pending-prompt, and cloud-poller.test.ts drives
    // real timers + localhost sockets. Sized to the core count, a loaded
    // machine oversubscribes and starves the event loop, making those windows
    // flaky. Cap parallelism and give hooks headroom so the suite is
    // deterministic in CI without slowing the happy path. Keep the default
    // `forks` pool (NOT threads): several suites mutate process.env
    // (HOME / PATH / AGENTBOX_PROMPT) and rely on per-file process isolation.
    hookTimeout: 30_000,
    testTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { minForks: 1, maxForks: 4 } },
  },
});
