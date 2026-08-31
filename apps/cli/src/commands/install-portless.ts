/**
 * `agentbox install portless` — set up Portless properly, once, so box URLs
 * keep working across reboots.
 *
 * Portless (https://portless.sh) is what turns a box's published port into
 * `https://<box>.localhost`. AgentBox can install the CLI and start a proxy on
 * demand, but a proxy started that way is just a process: it dies with the
 * machine, while the route registry it serves survives on disk. The result is
 * the failure this command exists to remove — `portless get` keeps answering
 * with a URL, `agentbox hub` keeps printing it, and nothing is listening.
 *
 * Portless ships the fix (`portless service install`: a root LaunchDaemon on
 * macOS, systemd on Linux, a startup task on Windows), so this command drives
 * that rather than hand-rolling autostart, and pairs it with the CA trust the
 * HTTPS proxy needs.
 */

import { confirm, intro, log, note, outro, spinner } from '@agentbox/cli-kit';
import { Command } from 'commander';
import {
  detectPortless,
  ensurePortlessProxy,
  installPortless,
  installPortlessService,
  portlessGetUrl,
  portlessInstallHint,
  portlessServiceStatus,
  resetPortlessCache,
  uninstallPortlessService,
} from '@agentbox/sandbox-docker';

interface InstallPortlessOptions {
  uninstall?: boolean;
  yes?: boolean;
}

/**
 * Offer to make an already-running proxy permanent. Interactive-only and
 * best-effort: called from the first-run opt-in and from this command, never
 * from a background path. A "no" is simply not repeated in that session — the
 * `doctor` row keeps the nudge visible without another prompt.
 */
export async function offerPortlessService(): Promise<void> {
  if (!process.stdin.isTTY) return;
  const service = await portlessServiceStatus();
  if (service.installed) return;

  const yes = await confirm({
    message:
      'Start the Portless proxy automatically at boot? ' +
      '(otherwise box URLs stop working after every restart)',
    initialValue: true,
  });
  if (!yes) {
    log.info('Skipped — run `agentbox install portless` later to set it up.');
    return;
  }
  await runServiceInstall();
}

/**
 * Install the OS service, reporting what happened. Shared by the interactive
 * offer and the command itself.
 */
async function runServiceInstall(): Promise<boolean> {
  // The service runs Portless's default mode — HTTPS on :443 — so a host that
  // was on the no-root :1355 proxy moves to clean, port-less URLs. That is the
  // mode the rest of AgentBox is written against (a cloud box mirrors it
  // internally, and `{{AGENTBOX_BOX_HOST}}` templates spell `https://…` by
  // hand), but it *does* change existing box URLs, so say so before prompting.
  log.info(
    'Installing the Portless startup service (HTTPS on port 443) — ' +
      'you may be asked for your password. Box URLs become https://<box>.localhost ' +
      '(the same URL that works inside a box).',
  );
  const res = await installPortlessService();
  resetPortlessCache();
  if (res === 'cancelled') {
    log.warn('Password prompt dismissed — the proxy will not start at boot.');
    return false;
  }
  if (res === 'failed') {
    log.warn('Could not install the Portless startup service — run `portless service install`.');
    return false;
  }
  const service = await portlessServiceStatus();
  if (!service.installed) {
    log.warn(
      'Portless reported success but the service is not registered — check `portless service status`.',
    );
    return false;
  }
  log.success('Portless starts at boot now.');
  return true;
}

export const installPortlessCommand = new Command('portless')
  .description(
    'Install Portless and start its proxy at boot, so https://<box>.localhost URLs survive a reboot.',
  )
  .option('--uninstall', 'remove the Portless startup service (leaves the CLI installed)')
  .option('-y, --yes', 'no prompts: install the CLI and the startup service')
  .action(async (opts: InstallPortlessOptions) => {
    intro('agentbox install portless');

    if (opts.uninstall === true) {
      const ok = await uninstallPortlessService();
      if (ok) outro('Portless startup service removed.');
      else {
        log.warn('Could not remove the service — run `portless service uninstall`.');
        outro('nothing changed');
      }
      return;
    }

    let state = await detectPortless();
    if (!state.installed) {
      const s = spinner();
      s.start(`installing portless (${portlessInstallHint()})`);
      const ok = await installPortless();
      resetPortlessCache();
      s.stop(ok ? 'portless installed' : 'portless install failed');
      if (!ok) {
        log.warn(`Run \`${portlessInstallHint()}\` yourself, then re-run this command.`);
        outro('nothing changed');
        return;
      }
      state = await detectPortless();
    }

    const service = await portlessServiceStatus();
    if (service.installed) {
      log.info('Portless startup service already installed.');
    } else if (opts.yes === true) {
      await runServiceInstall();
    } else if (process.stdin.isTTY) {
      await offerPortlessService();
    } else {
      // Installing the service raises a password dialog. Never do that from a
      // script or a hook that nobody is watching — say what to run instead.
      log.info('Startup service not installed — run `agentbox install portless -y` to add it.');
    }

    // Whether or not the service went in, leave the host with a live proxy —
    // the service starts one at *boot*, not retroactively for this session.
    state = await ensurePortlessProxy({ allowRootPrompt: false });
    if (!state.proxyRunning) {
      log.warn('No Portless proxy is running — box URLs fall back to loopback ports.');
      outro('done, with warnings');
      return;
    }

    // Show the real URL rather than an assumed one: whether it carries a port
    // and which scheme it uses is decided by whichever proxy actually answered.
    const hubUrl = await portlessGetUrl('agentbox');
    const boxUrl = hubUrl.replace('//agentbox.', '//<box>.');
    note([`hub:   ${hubUrl}`, `boxes: ${boxUrl}`].join('\n'), 'URLs served by this proxy');
    outro('portless ready');
  });
