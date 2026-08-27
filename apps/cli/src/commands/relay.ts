import { readFile } from 'node:fs/promises';
import { log, spinner } from '@clack/prompts';
import {
  ensureRelay,
  getRelayStatus,
  rehydrateRelayRegistry,
  stopRelay,
  type RelayStatus,
} from '@agentbox/sandbox-docker';
import { readState } from '@agentbox/sandbox-core';
import { loadEffectiveConfig } from '@agentbox/config';
import { Command } from 'commander';
import { handleLifecycleError } from './_errors.js';

interface ControlPlaneInfo {
  url: string;
  reachable: boolean;
  boxes?: number;
  events?: number;
}

/**
 * Probe the configured control box (`relay.controlPlaneUrl`) `/healthz`, so
 * `relay status` shows the intermediary the PC operates through. Returns null
 * when no control box is configured. Never throws (an unreachable box is a
 * status line, not an error).
 */
async function probeControlPlane(): Promise<ControlPlaneInfo | null> {
  let url = '';
  try {
    const cfg = await loadEffectiveConfig(process.cwd());
    url = (cfg.effective.relay.controlPlaneUrl ?? '').replace(/\/$/, '');
  } catch {
    return null;
  }
  if (!url) return null;
  try {
    const ctrl = AbortSignal.timeout(6000);
    const res = await fetch(`${url}/healthz`, { signal: ctrl });
    if (!res.ok) return { url, reachable: false };
    const body = (await res.json()) as { boxes?: number; events?: number };
    return { url, reachable: true, boxes: body.boxes, events: body.events };
  } catch {
    return { url, reachable: false };
  }
}

function renderControlPlane(cp: ControlPlaneInfo): string {
  const head = `control box: ${cp.reachable ? 'reachable' : 'UNREACHABLE'} (this PC operates through it)`;
  const lines = [head, `  url:    ${cp.url}`];
  if (cp.reachable)
    lines.push(`  health: ${String(cp.boxes ?? 0)} box(es), ${String(cp.events ?? 0)} event(s)`);
  return lines.join('\n');
}

/**
 * After a fresh relay process starts (cold start or restart), it has no
 * in-memory box registry — and for cloud boxes that means no `CloudBoxPoller`
 * is running. Re-push every persisted (id, token, kind, preview…) so the
 * relay regains the same registry it had before the restart. Lifts the
 * cloud poller back up so status push + git push resume seamlessly.
 */
export async function rehydrateFromState(): Promise<void> {
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
      autoApproveHostActions: b.autoApproveHostActions,
      autoApproveSafeHostActions: b.autoApproveSafeHostActions,
    })),
  );
}

interface StatusOpts {
  json?: boolean;
}

function renderStatus(s: RelayStatus): string {
  if (s.running && s.health) {
    return [
      // A hub answering here means no lean relay process exists at all — and no
      // relay.pid, which is why `pid` falls back to the one /healthz reports.
      s.health.ui === true ? 'relay: running (served by the hub)' : 'relay: running',
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
      const [s, cp] = await Promise.all([getRelayStatus(), probeControlPlane()]);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ...s, controlPlane: cp }, null, 2) + '\n');
        return;
      }
      process.stdout.write(renderStatus(s) + '\n');
      if (cp) process.stdout.write('\n' + renderControlPlane(cp) + '\n');
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
        result.stopped ? `stopped relay (pid ${String(result.pid)})` : 'relay was not running',
      );
    } catch (err) {
      handleLifecycleError(err);
    }
  });

/**
 * Bring the relay up and REPORT WHAT IS ACTUALLY THERE.
 *
 * `ensureRelay()` returning an endpoint is not proof of liveness — it also
 * returns when it reused an incumbent, handed off to a hub, or gave up on a pid
 * whose /healthz stays silent. Printing its URL unconditionally is how a relay
 * that died on EADDRINUSE reported success while the box's RPCs went to whatever
 * else held the port. So: re-probe, and say `hub` when a hub is what answers
 * (there is no lean relay process in that case).
 */
async function startAndReport(s: ReturnType<typeof spinner>): Promise<void> {
  await ensureRelay();
  await rehydrateFromState();
  const status = await getRelayStatus();
  if (!status.running) {
    s.stop('relay failed to start');
    log.error(`nothing is answering /healthz on ${status.endpoint.hostUrl}`);
    const tail = await tailLog(status.logFile);
    log.info(tail ? `last lines of ${status.logFile}:\n${tail}` : `see ${status.logFile}`);
    process.exit(1);
  }
  const what = status.health?.ui === true ? 'hub (serving the relay)' : 'relay';
  s.stop(`${what} running on ${status.endpoint.hostUrl}`);
}

/** Last few non-empty lines of the relay log, or '' when unreadable. */
async function tailLog(file: string): Promise<string> {
  try {
    const lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim().length > 0);
    return lines.slice(-10).join('\n');
  } catch {
    return '';
  }
}

const startSub = new Command('start')
  .description('Start the host relay if not already running (idempotent)')
  .action(async () => {
    try {
      const s = spinner();
      s.start('starting relay');
      await startAndReport(s);
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
        stopped.stopped ? `stopped relay (pid ${String(stopped.pid)})` : 'relay was not running',
      );
      const s2 = spinner();
      s2.start('starting relay');
      try {
        await startAndReport(s2);
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
