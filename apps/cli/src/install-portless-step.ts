/**
 * The Portless step of `agentbox install`: set up `https://<box>.localhost` once,
 * at install, instead of on the first interactive create (which a box created
 * from the tray or the hub web UI never reaches).
 */

import { execa } from 'execa';
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
 * The providers that use a `<box>.localhost` alias without Docker Desktop: their
 * box web URL is an SSH-forwarded loopback port. Named in the optional prompt.
 */
const ALIAS_CLOUDS = 'hetzner, DigitalOcean or remote-docker';
const ALIAS_CLOUD_PROVIDERS = new Set(['hetzner', 'digitalocean', 'remote-docker']);

/**
 * `ask`: default-yes prompt. `ask-optional`: default-no prompt, because this
 * host only needs Portless if the user later picks an alias-using cloud.
 */
export type PortlessStepDecision = 'skip' | 'ask' | 'ask-optional' | 'setup';

export interface PortlessStepInput {
  /** `--provider`, when the user named one: then only that provider matters. */
  provider?: string;
  /** Local docker is offered on this host (false under a control box / `hub.mode=thin`). */
  dockerOffered: boolean;
  platform: NodeJS.Platform;
  engine: DockerEngine;
  /** Effective `portless.enabled`; `undefined` = never decided. */
  enabled: boolean | undefined;
  yes: boolean;
  /** The Portless CLI answers, or a proxy does. */
  installed: boolean;
  /** Portless CLI present, a proxy serving, and its boot-time service installed. */
  fullySetUp: boolean;
}

/**
 * Whether the install wizard should ask about Portless, set it up without
 * asking, or leave it alone. Runs before the provider picker, so it decides
 * from the host alone. Pure, for tests.
 *
 * Default-yes on macOS with Docker Desktop (local docker boxes get
 * `<box>.localhost`), and on any host where Portless is already installed (the
 * user clearly wants it). OrbStack serves `<container>.orb.local`, and `'other'`
 * (Colima, Rancher, Podman, or a `docker info` that failed) is no reason to
 * install anything for docker, so those hosts — and Linux — get a default-no
 * prompt naming the clouds that would use it; `-y` skips that one. An explicit
 * `false` is a past "no" and is never re-asked; a `true` on a host that lost
 * part of the setup is repaired without a question.
 *
 * A named `--provider` narrows it: an alias cloud is wanted outright, docker
 * only on Docker Desktop, and the public-URL clouds (daytona, vercel, e2b) never
 * need it. Docker Desktop counts only while local docker is offered at all.
 */
export function decidePortlessStep(i: PortlessStepInput): PortlessStepDecision {
  if (i.platform !== 'darwin' && i.platform !== 'linux') return 'skip';
  if (i.enabled === false) return 'skip';
  if (i.enabled === true) return i.fullySetUp ? 'skip' : 'setup';
  const dockerDesktop = i.dockerOffered && i.platform === 'darwin' && i.engine === 'docker-desktop';
  if (i.provider !== undefined) {
    const providerWants = ALIAS_CLOUD_PROVIDERS.has(i.provider)
      ? true
      : i.provider === 'docker'
        ? dockerDesktop
        : false;
    if (!providerWants && !(i.provider === 'docker' && i.installed)) return 'skip';
    return i.yes ? 'setup' : 'ask';
  }
  const wanted = dockerDesktop || i.installed;
  if (i.yes) return wanted ? 'setup' : 'skip';
  return wanted ? 'ask' : 'ask-optional';
}

/** Whether a provider's box URL is a host loopback port Portless can alias without Docker Desktop. */
export function isAliasCloud(provider: string): boolean {
  return ALIAS_CLOUD_PROVIDERS.has(provider);
}

/**
 * Whether the docker CLI's current context is Docker Desktop's. Read from the
 * context, not a live `docker info`: Docker Desktop installed but not running
 * still means this user's docker boxes will want Portless. Never throws.
 */
export async function dockerContextIsDesktop(): Promise<boolean> {
  try {
    const show = await execa('docker', ['context', 'show'], { reject: false, timeout: 5000 });
    const name = String(show.stdout ?? '').trim();
    if (show.exitCode !== 0 || name === '') return false;
    if (name === 'desktop-linux') return true;
    const ep = await execa(
      'docker',
      ['context', 'inspect', name, '--format', '{{.Endpoints.docker.Host}}'],
      { reject: false, timeout: 5000 },
    );
    // Docker Desktop's macOS socket; `default` points here once Desktop has run.
    return ep.exitCode === 0 && String(ep.stdout ?? '').includes('/.docker/run/docker.sock');
  } catch {
    return false;
  }
}

/**
 * What the step left behind: `unset` means `portless.enabled` is still
 * undecided (skipped, cancelled, or a "no" to the optional prompt, which is
 * never saved), so the wizard asks once more if the user then picks an alias
 * cloud.
 */
export type PortlessStepOutcome = 'unset' | 'decided';

/**
 * Whether to ask about Portless again after the provider picker: the first ask
 * left it undecided and the user then picked an alias cloud. A provider named
 * with `--provider` was already part of the first decision. Pure.
 */
export function shouldReaskAfterPick(
  outcome: PortlessStepOutcome,
  namedProvider: string | undefined,
  picked: string,
): boolean {
  return !namedProvider && outcome === 'unset' && isAliasCloud(picked);
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
  provider?: string;
  dockerOffered: boolean;
  enabled: boolean | undefined;
  yes: boolean;
}): Promise<PortlessStepOutcome> {
  const unsetUnlessDecided = args.enabled === undefined ? 'unset' : 'decided';
  try {
    const engine: DockerEngine =
      process.platform !== 'darwin'
        ? 'other'
        : (await dockerContextIsDesktop())
          ? 'docker-desktop'
          : await detectEngine();
    const state = await detectPortless();
    let fullySetUp = false;
    if (args.enabled === true && state.installed) {
      const service: PortlessServiceState = await portlessServiceStatus();
      // A crash-looping service brings nothing back after a reboot.
      fullySetUp = state.proxyRunning && service.installed && service.failing !== true;
    }
    const decision = decidePortlessStep({
      ...(args.provider !== undefined ? { provider: args.provider } : {}),
      dockerOffered: args.dockerOffered,
      platform: process.platform,
      engine,
      enabled: args.enabled,
      yes: args.yes,
      installed: state.installed,
      fullySetUp,
    });
    if (decision === 'skip') return unsetUnlessDecided;

    if (decision === 'ask' || decision === 'ask-optional') {
      const optional = decision === 'ask-optional';
      note(
        // Kept under ~70 columns: the note's frame must fit an 80-column terminal.
        [
          'Portless gives each box web app a stable https://<box>.localhost',
          'URL, the same one that works inside the box, instead of a random',
          '127.0.0.1 port.',
          ...(optional ? [`Only needed for ${ALIAS_CLOUDS} boxes.`] : []),
          'It installs the portless CLI, starts its proxy, and can start it',
          'at boot (you may be asked for your password).',
        ].join('\n'),
        'Box URLs',
      );
      const answer = await confirm({ message: 'Set up Portless?', initialValue: !optional });
      // A cancel is not a "no": leave it undecided so it is asked again.
      if (isCancel(answer)) return 'unset';
      if (answer !== true) {
        log.info(`Skipped — box URLs use loopback ports. Later: \`${portlessServiceHint()}\`.`);
        // The optional prompt's "no" is not saved: this host may not have been
        // the one it was for (Docker Desktop stopped, a cloud picked next), and
        // a saved `false` is never asked again.
        if (optional) return 'unset';
        await persistEnabled(false);
        return 'decided';
      }
      await persistEnabled(true);
      await setupPortlessHost({ allowRootPrompt: true });
      return 'decided';
    }

    if (args.enabled === true) {
      // Repair of an opted-in host. From a terminal it may ask for the password
      // (the :443 proxy, the boot service); `-y` never does. Never a mode change:
      // a dismissed prompt must not quietly move live https URLs to :1355.
      await setupPortlessHost({ allowRootPrompt: !args.yes, allowModeChange: false });
      if (!args.yes) return 'decided';
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
    return 'decided';
  } catch (err) {
    log.warn(
      `Portless setup skipped: ${err instanceof Error ? err.message : String(err)} — box URLs use loopback ports.`,
    );
    return unsetUnlessDecided;
  }
}
