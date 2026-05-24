/**
 * Cloud end-to-end smoke test. Real Daytona sandbox lifecycle gated on
 * `DAYTONA_API_KEY` (and optionally `DAYTONA_ORGANIZATION_ID`). Skipped
 * silently when the env isn't configured — CI without the secrets sees
 * nothing; a developer with `~/.agentbox/secrets.env` exported can run
 * `pnpm --filter @madarco/agentbox test cloud-e2e` and exercise the full
 * provision → shell → destroy path.
 *
 * Cost: ~3-5 minutes of wall time, ~1 free-tier Daytona sandbox.
 *
 * Cleanup: `afterAll` always runs `destroy`; if a kill-9 prevents that,
 * `agentbox prune --provider daytona -y` (task 6.3) reaps the orphan.
 */

import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';

const hasCreds = !!process.env['DAYTONA_API_KEY'];

// `describe.skipIf` keeps the suite quiet when the env isn't set — running
// `pnpm test` without the keys shouldn't print "skipped" noise for every
// case.
describe.skipIf(!hasCreds)('cloud e2e (DAYTONA_API_KEY)', () => {
  const cliEntry = require.resolve('../dist/index.js');
  const boxName = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agentbox-e2e-'));
    // Initialize a tiny git repo so seedCloudWorkspace has a bundle to ship.
    await execa('git', ['init', '-q'], { cwd: workspace });
    await execa('git', ['-c', 'user.email=ci@agentbox', '-c', 'user.name=ci', 'commit', '--allow-empty', '-m', 'init'], {
      cwd: workspace,
    });
  }, 30_000);

  afterAll(async () => {
    if (workspace) {
      // Best-effort destroy; ignore non-zero exits (the test may have
      // failed before recording state).
      await execa('node', [cliEntry, 'destroy', boxName, '-y'], {
        reject: false,
      }).catch(() => {
        /* ignore */
      });
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it(
    'create → shell -- echo → destroy round-trip',
    async () => {
      // Create
      const create = await execa(
        'node',
        [cliEntry, 'create', '--provider', 'daytona', '-y', '-n', boxName, '--no-vnc'],
        { cwd: workspace, reject: false, timeout: 600_000 },
      );
      expect(create.exitCode, `create stderr: ${create.stderr}`).toBe(0);

      // Shell one-shot — round-trips through SSH + provider.buildAttach.
      const shell = await execa(
        'node',
        [cliEntry, 'shell', boxName, '--', 'echo', 'agentbox-e2e-ping'],
        { cwd: workspace, reject: false, timeout: 60_000 },
      );
      expect(shell.exitCode, `shell stderr: ${shell.stderr}`).toBe(0);
      expect(shell.stdout).toMatch(/agentbox-e2e-ping/);

      // Status — exercises provider.probeState.
      const status = await execa('node', [cliEntry, 'status', boxName], {
        cwd: workspace,
        reject: false,
        timeout: 30_000,
      });
      expect(status.exitCode).toBe(0);

      // Destroy
      const destroy = await execa('node', [cliEntry, 'destroy', boxName, '-y'], {
        cwd: workspace,
        reject: false,
        timeout: 180_000,
      });
      expect(destroy.exitCode, `destroy stderr: ${destroy.stderr}`).toBe(0);
    },
    900_000, // 15-minute total budget — first-run Dockerfile.box snapshot is ~7 min cold.
  );
});
