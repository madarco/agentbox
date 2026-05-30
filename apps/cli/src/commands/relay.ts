import { log, spinner } from '@clack/prompts';
import {
  ensureRelay,
  getRelayStatus,
  rehydrateRelayRegistry,
  stopRelay,
  type RelayStatus,
} from '@agentbox/sandbox-docker';
import { readState } from '@agentbox/sandbox-core';
import { Command } from 'commander';
import { handleLifecycleError } from './_errors.js';

/**
 * After a fresh relay process starts (cold start or restart), it has no
 * in-memory box registry — and for cloud boxes that means no `CloudBoxPoller`
 * is running. Re-push every persisted (id, token, kind, preview…) so the
 * relay regains the same registry it had before the restart. Lifts the
 * cloud poller back up so status push + git push resume seamlessly.
 */
async function rehydrateFromState(): Promise<void> {
  const state = await readState();
  await rehydrateRelayRegistry(
    state.boxes.map((b) => ({
      id: b.id,
      name: b.name,
      provider: b.provider,
      container: b.container,
      createdAt: b.createdAt,
      relayToken: b.relayToken,
      projectIndex: b.projectIndex,
      gitWorktrees: b.gitWorktrees,
      cloudBackend: b.cloud?.backend,
      relayPreviewUrl: b.cloud?.relayPreviewUrl,
      relayPreviewToken: b.cloud?.relayPreviewToken,
      bridgeToken: b.cloud?.bridgeToken,
    })),
  );
}

interface StatusOpts {
  json?: boolean;
}

function renderStatus(s: RelayStatus): string {
  if (s.running && s.health) {
    return [
      'relay: running',
      `  pid:     ${s.pid === null ? '?' : String(s.pid)}`,
      `  port:    ${String(s.port)}`,
      `  url:     ${s.endpoint.hostUrl}`,
      `  version: ${s.health.version ?? '(unknown — relay predates version field)'}`,
      `  commit:  ${s.health.commit ?? '(unknown)'}`,
      `  boxes:   ${String(s.health.boxes)}`,
      `  events:  ${String(s.health.events)}`,
      `  log:     ${s.logFile}`,
    ].join('\n');
  }
  if (s.pidAlive) {
    return [
      `relay: not responding (pid ${String(s.pid)} alive but /healthz silent)`,
      `  log:    ${s.logFile}`,
    ].join('\n');
  }
  return ['relay: not running', `  log:    ${s.logFile}`].join('\n');
}

const statusSub = new Command('status')
  .description('Show whether the host relay is running, with pid / port / box count')
  .option('--json', 'emit RelayStatus as JSON')
  .action(async (opts: StatusOpts) => {
    try {
      const s = await getRelayStatus();
      if (opts.json) {
        process.stdout.write(JSON.stringify(s, null, 2) + '\n');
        return;
      }
      process.stdout.write(renderStatus(s) + '\n');
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const stopSub = new Command('stop')
  .description('Stop the host relay process (idempotent)')
  .action(async () => {
    try {
      const s = spinner();
      s.start('stopping relay');
      const result = await stopRelay();
      s.stop(
        result.stopped
          ? `stopped relay (pid ${String(result.pid)})`
          : 'relay was not running',
      );
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const startSub = new Command('start')
  .description('Start the host relay if not already running (idempotent)')
  .action(async () => {
    try {
      const s = spinner();
      s.start('starting relay');
      const ep = await ensureRelay();
      await rehydrateFromState();
      s.stop(`relay running on ${ep.hostUrl}`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const restartSub = new Command('restart')
  .description('Stop then start the host relay')
  .action(async () => {
    try {
      const s = spinner();
      s.start('stopping relay');
      const stopped = await stopRelay();
      s.stop(
        stopped.stopped
          ? `stopped relay (pid ${String(stopped.pid)})`
          : 'relay was not running',
      );
      const s2 = spinner();
      s2.start('starting relay');
      try {
        const ep = await ensureRelay();
        await rehydrateFromState();
        s2.stop(`relay running on ${ep.hostUrl}`);
      } catch (err) {
        s2.stop('relay start failed');
        log.warn(err instanceof Error ? err.message : String(err));
        throw err;
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

export const relayCommand = new Command('relay')
  .description('Manage the host relay process (status / stop / start / restart)')
  .addCommand(statusSub, { isDefault: true })
  .addCommand(stopSub)
  .addCommand(startSub)
  .addCommand(restartSub);
