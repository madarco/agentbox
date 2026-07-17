import { spawn } from 'node:child_process';
import { log, spinner } from '@clack/prompts';
import { loadEffectiveConfig } from '@agentbox/config';
import { ensureHub, getHubStatus, stopHub, type HubStatus } from '@agentbox/sandbox-docker';
import { hostOpenCommand } from '@agentbox/sandbox-core';
import { Command } from 'commander';
import { handleLifecycleError } from './_errors.js';
import { rehydrateFromState } from './relay.js';
import { resolveCustodyTarget } from './control-plane.js';
import { CustodyClient } from '../control-plane/custody-client.js';
import { ControlPlaneAdminClient } from '../control-plane/admin-client.js';
import { pullBoxSshKeys } from '../control-plane/hub-pull.js';
import { adoptHubBox, HubBoxNotFoundError } from '../control-plane/hub-adopt.js';

/**
 * Effective `portless.enabled` for the hub's `agentbox.localhost` alias. The hub
 * is host-wide, so we resolve against the cwd (picks up the global layer). Best
 * effort — a config read failure just leaves it undefined (register best-effort).
 */
async function resolvePortlessEnabled(): Promise<boolean | undefined> {
  try {
    const cfg = await loadEffectiveConfig(process.cwd());
    return cfg.effective.portless.enabled;
  } catch {
    return undefined;
  }
}

/** Best-effort: open the hub URL in the host browser (never throws). */
function openInBrowser(url: string): void {
  try {
    const child = spawn(hostOpenCommand(), [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    /* the caller has already printed the URL */
  }
}

interface StatusOpts {
  json?: boolean;
}

function renderStatus(s: HubStatus): string {
  if (s.running) {
    return [
      `hub: running${s.ui ? '' : ' (bare relay on the port — no UI; run `agentbox hub start`)'}`,
      `  pid:  ${s.pid === null ? '?' : String(s.pid)}`,
      `  port: ${String(s.port)}`,
      `  url:  ${s.openUrl}`,
      `  log:  ${s.logFile}`,
    ].join('\n');
  }
  if (s.pidAlive) {
    return [`hub: not responding (pid ${String(s.pid)} alive but /healthz silent)`, `  log:  ${s.logFile}`].join('\n');
  }
  return ['hub: not running', `  log:  ${s.logFile}`].join('\n');
}

const statusSub = new Command('status')
  .description('Show whether the hub (relay + Web UI) is running, with its URL')
  .option('--json', 'emit HubStatus as JSON')
  .action(async (opts: StatusOpts) => {
    try {
      const s = await getHubStatus();
      if (opts.json) {
        process.stdout.write(JSON.stringify(s, null, 2) + '\n');
        return;
      }
      process.stdout.write(renderStatus(s) + '\n');
    } catch (err) {
      handleLifecycleError(err);
    }
  });

interface StartOpts {
  open?: boolean;
}

const startSub = new Command('start')
  .description('Start the hub (relay + Web UI on port 8787) and open it')
  .option('--no-open', "don't open the browser, just print the URL")
  .action(async (opts: StartOpts) => {
    try {
      const s = spinner();
      s.start('starting hub');
      const ep = await ensureHub({
        onLog: (line) => s.message(line),
        portlessEnabled: await resolvePortlessEnabled(),
      });
      await rehydrateFromState();
      s.stop(`hub running on ${ep.hostUrl}`);
      process.stdout.write(`\n  Open: ${ep.openUrl}\n\n`);
      if (opts.open !== false) openInBrowser(ep.openUrl);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const stopSub = new Command('stop')
  .description('Stop the hub process (idempotent)')
  .action(async () => {
    try {
      const s = spinner();
      s.start('stopping hub');
      const result = await stopHub();
      s.stop(result.stopped ? `stopped hub (pid ${String(result.pid)})` : 'hub was not running');
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const restartSub = new Command('restart')
  .description('Stop then start the hub')
  .option('--no-open', "don't open the browser, just print the URL")
  .action(async (opts: StartOpts) => {
    try {
      const s = spinner();
      s.start('stopping hub');
      const stopped = await stopHub();
      s.stop(stopped.stopped ? `stopped hub (pid ${String(stopped.pid)})` : 'hub was not running');
      const s2 = spinner();
      s2.start('starting hub');
      try {
        const ep = await ensureHub({
          onLog: (line) => s2.message(line),
          portlessEnabled: await resolvePortlessEnabled(),
        });
        await rehydrateFromState();
        s2.stop(`hub running on ${ep.hostUrl}`);
        process.stdout.write(`\n  Open: ${ep.openUrl}\n\n`);
        if (opts.open !== false) openInBrowser(ep.openUrl);
      } catch (err) {
        s2.stop('hub start failed');
        log.warn(err instanceof Error ? err.message : String(err));
        throw err;
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const pullSub = new Command('pull')
  .description("Download a control-box-created box's SSH keys so this PC can attach / port-forward / cp to it")
  .argument('<box>', 'box id or name as shown by `agentbox control-plane boxes list`')
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .action(async (box: string, opts: { url?: string }) => {
    try {
      const target = await resolveCustodyTarget(opts.url);
      if (!target) {
        process.exitCode = 1;
        return;
      }
      const res = await pullBoxSshKeys({
        admin: new ControlPlaneAdminClient(target),
        custody: new CustodyClient(target),
        box,
      });
      if (res.files.length === 0) {
        log.warn(
          `No SSH key material in custody for '${box}' (boxes/${res.key}/ssh). ` +
            (res.registered ? 'The box may mint no keypair (e2b/vercel).' : 'The box is not registered on the control box.'),
        );
        process.exitCode = 1;
        return;
      }
      log.success(`Pulled ${String(res.files.length)} key file(s) to ${res.dest} — attach / cp / port-forward now work.`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const adoptSub = new Command('adopt')
  .description(
    "Rebuild local state for a control-box-created box so it resolves by name here: writes its BoxRecord and downloads its SSH keys. After this it shows in `agentbox ls` and works with attach / cp / url / screen.",
  )
  .argument('<box>', 'box id, name, or sandbox id as shown by `agentbox control-plane boxes list`')
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .action(async (box: string, opts: { url?: string }) => {
    try {
      const target = await resolveCustodyTarget(opts.url);
      if (!target) {
        process.exitCode = 1;
        return;
      }
      const res = await adoptHubBox({
        admin: new ControlPlaneAdminClient(target),
        custody: new CustodyClient(target),
        ref: box,
        controlPlaneUrl: target.url,
        log: (line) => log.info(line),
      });
      const where = res.projectRoot
        ? `linked to ${res.projectRoot}`
        : 'no local clone of its repo — it shows under `agentbox ls -g` only';
      log.success(
        `${res.refreshed ? 'Refreshed' : 'Adopted'} ${res.record.name} (${res.record.provider} ${res.record.cloud?.sandboxId ?? ''}) — ${where}.`,
      );
    } catch (err) {
      if (err instanceof HubBoxNotFoundError) {
        log.error(`${err.message}. Run \`agentbox control-plane boxes list\` to see what's there.`);
        process.exitCode = 1;
        return;
      }
      handleLifecycleError(err);
    }
  });

export const hubCommand = new Command('hub')
  .description(
    'Run the AgentBox hub — the relay + Web UI on http://127.0.0.1:8787 ' +
      '(also https://agentbox.localhost when Portless is installed)',
  )
  .addCommand(startSub, { isDefault: true })
  .addCommand(statusSub)
  .addCommand(stopSub)
  .addCommand(restartSub)
  .addCommand(pullSub)
  .addCommand(adoptSub);
