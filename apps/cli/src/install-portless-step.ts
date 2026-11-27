/**
 * The Portless step of `agentbox install`: set up `https://<box>.localhost` once,
 * at install, instead of on the first interactive create (which a box created
 * from the tray or the hub web UI never reaches).
 */

import { confirm, isCancel, log, note } from '@agentbox/cli-kit';
import { setConfigValue } from '@agentbox/config';
import {
  detectEngine,
  detectPortless,
  type DockerEngine,
  type PortlessServiceState,
  portlessServiceHint,
  portlessServiceStatus,
} from '@agentbox/sandbox-docker';
import { setupPortlessHost } from './portless-prompt.js';

/**
 * Providers whose box web URL is a host loopback port (a docker publish or an
 * SSH forward), which Portless turns into `<box>.localhost`. The public-URL
 * clouds (daytona, vercel, e2b) hand out a reachable URL already.
 */
const LOOPBACK_URL_PROVIDERS = new Set(['docker', 'hetzner', 'digitalocean', 'remote-docker']);

export type PortlessStepDecision = 'skip' | 'ask' | 'setup';

export interface PortlessStepInput {
  provider: string;
  platform: NodeJS.Platform;
  engine: DockerEngine;
  /** Effective `portless.enabled`; `undefined` = never decided. */
  enabled: boolean | undefined;
  yes: boolean;
  /** Portless CLI present, a proxy serving, and its boot-time service installed. */
  fullySetUp: boolean;
}

/**
 * Whether the install wizard should ask about Portless, set it up without
 * asking, or leave it alone. Pure, for tests.
 *
 * Docker: macOS with Docker Desktop only. OrbStack serves `<container>.orb.local`,
 * and `'other'` (Colima, Rancher, Podman, or a `docker info` that failed —
 * OrbStack stopped, no docker at all) is not a reason to install anything.
 * An explicit `false` is a past "no" and is never re-asked; a `true` on a host
 * that lost part of the setup is repaired without a question.
 */
export function decidePortlessStep(i: PortlessStepInput): PortlessStepDecision {
  if (!LOOPBACK_URL_PROVIDERS.has(i.provider)) return 'skip';
  if (i.provider === 'docker' && (i.platform !== 'darwin' || i.engine !== 'docker-desktop')) {
    return 'skip';
  }
  if (i.platform === 'win32') return 'skip';
  if (i.enabled === false) return 'skip';
  if (i.enabled === true) return i.fullySetUp ? 'skip' : 'setup';
  return i.yes ? 'setup' : 'ask';
}

async function persistEnabled(value: boolean): Promise<void> {
  try {
    await setConfigValue('global', 'portless.enabled', value, process.cwd(), { raw: false });
  } catch (err) {
    log.warn(
      `Could not save the Portless preference: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Run the step. Interactive: explain, ask, then install the CLI, start the
 * proxy and offer the boot-time service (`setupPortlessHost`, one password
 * prompt each). `-y`: no password prompt — the CLI is installed and
 * `portless.enabled` saved, but a proxy only starts where that needs no root
 * (a fresh host defaults to the :443 mode, so it does not); box URLs stay on
 * loopback until `agentbox install portless` runs.
 * Never throws: a Portless failure leaves box URLs on loopback ports.
 */
export async function runPortlessInstallStep(args: {
  provider: string;
  enabled: boolean | undefined;
  yes: boolean;
}): Promise<void> {
  try {
    const engine = args.provider === 'docker' ? await detectEngine() : 'other';
    let fullySetUp = false;
    if (args.enabled === true) {
      const state = await detectPortless();
      const service: PortlessServiceState = state.installed
        ? await portlessServiceStatus()
        : { installed: false };
      // A crash-looping service brings nothing back after a reboot.
      fullySetUp =
        state.installed && state.proxyRunning && service.installed && service.failing !== true;
    }
    const decision = decidePortlessStep({
      provider: args.provider,
      platform: process.platform,
      engine,
      enabled: args.enabled,
      yes: args.yes,
      fullySetUp,
    });
    if (decision === 'skip') return;

    if (decision === 'ask') {
      note(
        [
          'Portless gives each box web app a stable https://<box>.localhost URL,',
          'the same one that works inside the box, instead of a random 127.0.0.1 port.',
          'It installs the portless CLI, starts its proxy, and can start it at boot',
          '(you may be asked for your password).',
        ].join('\n'),
        'Box URLs',
      );
      const answer = await confirm({ message: 'Set up Portless?', initialValue: true });
      // A cancel is not a "no": leave it undecided so it is asked again.
      if (isCancel(answer)) return;
      await persistEnabled(answer === true);
      if (answer !== true) {
        log.info(`Skipped — box URLs use loopback ports. Later: \`${portlessServiceHint()}\`.`);
        return;
      }
      await setupPortlessHost({ allowRootPrompt: true });
      return;
    }

    if (args.enabled === true) {
      // Repair of an opted-in host. From a terminal it may ask for the password
      // (the :443 proxy, the boot service); `-y` never does. Never a mode change:
      // a dismissed prompt must not quietly move live https URLs to :1355.
      await setupPortlessHost({ allowRootPrompt: !args.yes, allowModeChange: false });
      if (!args.yes) return;
    } else {
      await persistEnabled(true);
      await setupPortlessHost({ allowRootPrompt: false });
    }
    // setupPortlessHost already pointed at the fix when no proxy came up.
    const live = (await detectPortless()).proxyRunning;
    if (live && !(await portlessServiceStatus()).installed) {
      log.info(
        `To keep box URLs working after a reboot, run \`${portlessServiceHint()}\` (asks for your password).`,
      );
    }
  } catch (err) {
    log.warn(
      `Portless setup skipped: ${err instanceof Error ? err.message : String(err)} — box URLs use loopback ports.`,
    );
  }
}
