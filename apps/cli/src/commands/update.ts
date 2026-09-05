import { spawn } from 'node:child_process';
import { confirm, intro, log, outro } from '@agentbox/cli-kit';
import { DEFAULT_BOX_IMAGE } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { detectExecutionMethod, type ExecMethod } from '../exec-method.js';
import { handleLifecycleError } from './_errors.js';
import {
  NIGHTLY_DIST_TAG,
  NPM_PACKAGE,
  STABLE_DIST_TAG,
  isPrerelease,
  persistChannel,
  resolveChannel,
  type UpdateChannel,
} from '../lib/channel.js';
import { runPostUpdateRefresh } from '../lib/post-update-refresh.js';
import {
  decideHubUpdate,
  describeHubUpdate,
  type HubUpdateDecision,
} from '../lib/hub-update-decision.js';
import { fetchNpmBest } from '../lib/update-check.js';
import { isNewer } from '../lib/semver-lite.js';
import { maybePromptStar } from '../lib/star-prompt.js';
import { AGENTBOX_VERSION } from '../version.js';

interface UpdateOptions {
  yes?: boolean;
  dryRun?: boolean;
  skipSelf?: boolean;
  skipSkills?: boolean;
  skipPlugins?: boolean;
  skipHub?: boolean;
  channel?: string;
}

/** The published npm package name (apps/cli/package.json `name`). */
const PKG = NPM_PACKAGE;

/**
 * What to install. On the nightly channel the newest build can live under either
 * dist-tag, so we install the resolved **version** rather than a tag — asking
 * for `@nightly` when the winner is a stable release would install an older
 * build, silently downgrading the tester.
 *
 * Falls back to the channel's own dist-tag when the registry couldn't be reached,
 * so an offline `self-update` still does the obvious thing.
 */
function selfUpdateCommand(
  method: ExecMethod,
  spec: string,
): { cmd: string; args: string[] } | null {
  if (method === 'npm') return { cmd: 'npm', args: ['install', '-g', `${PKG}@${spec}`] };
  if (method === 'pnpm') return { cmd: 'pnpm', args: ['add', '-g', `${PKG}@${spec}`] };
  return null;
}

function describeSelfUpdate(method: ExecMethod, spec: string): string {
  switch (method) {
    case 'npm':
      return `self-update: npm install -g ${PKG}@${spec}`;
    case 'pnpm':
      return `self-update: pnpm add -g ${PKG}@${spec}`;
    case 'npx':
      return 'self-update: skipped (running via npx — always the latest version)';
    case 'direct':
      return 'self-update: skipped (running from source — no global install to update)';
  }
}

export type SelfUpdateDecision =
  | { install: false; reason: 'flag' | 'already-newest' }
  | { install: true; reason: 'newer' | 'switching' | 'offline' };

/**
 * Whether to actually run the package install.
 *
 * The case this exists for: `newest` is only "the newest **published** version",
 * and on the nightly channel the installed build is regularly ahead of what the
 * dist-tags point at (right after a publish, before the next one, or a locally
 * built one). Installing `newest` there would silently DOWNGRADE the user.
 *
 * The one sanctioned backward move is **leaving a pre-release for stable**: opting
 * out of nightly means landing on the newest *release*, which sorts lower than the
 * prerelease in hand.
 *
 * It is deliberately keyed on `isPrerelease(installed) && target === 'stable'`
 * rather than on "the channels differ" or on whether `--channel` was passed. Both
 * looser forms reinstall something older in a reachable state:
 *   - "`--channel` was passed" → `--channel nightly` while already on a nightly
 *     installs the older stable, the opposite of the request.
 *   - "channels differ" → after a crossover the running build is a plain release
 *     while the target is still `nightly`; if the `latest` probe transiently fails
 *     and the `nightly` tag still points at the prerelease that release superseded,
 *     the user gets dragged back onto it.
 */
export function decideSelfUpdate(input: {
  installed: string;
  /** Newest published version on the target channel; undefined when the registry was unreachable. */
  newest: string | undefined;
  /** Channel being installed from. */
  target: UpdateChannel;
  skipSelfFlag: boolean;
}): SelfUpdateDecision {
  if (input.skipSelfFlag) return { install: false, reason: 'flag' };
  if (input.newest === undefined) return { install: true, reason: 'offline' };
  if (isNewer(input.newest, input.installed)) return { install: true, reason: 'newer' };
  if (input.newest === input.installed) return { install: false, reason: 'already-newest' };
  // Older than what's installed: only acceptable to leave a pre-release for stable.
  return isPrerelease(input.installed) && input.target === 'stable'
    ? { install: true, reason: 'switching' }
    : { install: false, reason: 'already-newest' };
}

/**
 * Read the deploy record + ask the control box what it runs, then decide.
 *
 * Both reads are best-effort: no control box (the common case) and an
 * unreachable one must never derail a local update, so a failure to *probe*
 * still yields an update decision (unreachable is a reason to redeploy) while a
 * failure to read the record yields "nothing to do". The modules are imported
 * lazily — the control-plane graph is heavy and irrelevant to a machine that has
 * no control box.
 */
async function resolveHubUpdate(args: {
  skipHubFlag: boolean;
  targetVersion: string;
}): Promise<HubUpdateDecision> {
  if (args.skipHubFlag) {
    return decideHubUpdate({ record: null, liveVersion: undefined, ...args });
  }
  try {
    const { readDeployRecord } = await import('../control-plane/deploy-hetzner.js');
    const record = await readDeployRecord();
    if (!record?.url || record.provider === 'local') {
      return decideHubUpdate({ record, liveVersion: undefined, ...args });
    }
    const { probeControlPlaneStatus } = await import('./control-plane.js');
    const live = await probeControlPlaneStatus(record.url).catch(() => null);
    return decideHubUpdate({ record, liveVersion: live?.version, ...args });
  } catch {
    return decideHubUpdate({ record: null, liveVersion: undefined, ...args });
  }
}

function runInherit(cmd: string, args: string[]): Promise<number> {
  return new Promise<number>((resolveP, rejectP) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', rejectP);
    child.on('close', (code) => resolveP(code ?? 0));
  });
}

/** Newest published version on `channel`; undefined when the registry is unreachable. */
async function fetchNewest(channel: UpdateChannel): Promise<string | undefined> {
  try {
    return await fetchNpmBest(channel);
  } catch {
    return undefined; // offline — the caller falls back to a dist-tag
  }
}

/** The current-vs-newest line, phrased for what is actually about to happen. */
function describeResolution(
  channel: UpdateChannel,
  newest: string | undefined,
  decision: SelfUpdateDecision,
): string {
  const on = channel === 'nightly' ? ' [nightly channel]' : '';
  if (newest === undefined)
    return `could not reach the registry — updating from \`${channel}\`${on}`;
  if (decision.reason === 'switching') {
    // A deliberate move off the installed build's channel: `newest` sorts LOWER
    // than what's installed, so "already the newest" would read as a contradiction
    // next to a plan that installs it.
    return `switching to the ${channel} channel: ${AGENTBOX_VERSION} → ${newest}`;
  }
  if (decision.install) return `current ${AGENTBOX_VERSION} → newest ${newest}${on}`;
  return `already the newest (${AGENTBOX_VERSION})${on} — refreshing skills/image/relay/app anyway`;
}

export const updateCommand = new Command('self-update')
  .description(
    'Update agentbox: self-update via npm/pnpm (unless run via npx), refresh the host skills, re-check the box image (rebuilt on the next create only if its build context changed), reload the relay/hub, and update the menu-bar app',
  )
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--dry-run', "show what would happen, don't change anything")
  .option(
    '--skip-self',
    'skip the package self-update; only refresh the skills, re-check the image, and reload the relay + app',
  )
  .option(
    '--skip-skills',
    'skip refreshing the host skill files in ~/.claude, ~/.codex, ~/.config/opencode',
  )
  .option('--skip-plugins', 'skip updating registered provider plugin packages')
  .option('--skip-hub', 'skip updating the deployed control box, if one is configured')
  .option(
    '--channel <channel>',
    'switch release channel: `nightly` opts into pre-release builds, `stable` opts back out (persisted as update.channel)',
  )
  .action(async (opts: UpdateOptions) => {
    try {
      const method = detectExecutionMethod({
        userAgent: process.env.npm_config_user_agent,
        argv1: process.argv[1],
      });

      intro('agentbox self-update');

      if (opts.channel !== undefined && opts.channel !== 'stable' && opts.channel !== 'nightly') {
        throw new Error(`--channel must be \`stable\` or \`nightly\` (got "${opts.channel}")`);
      }
      const channel: UpdateChannel = opts.channel ?? (await resolveChannel());
      const newest = await fetchNewest(channel);

      // Fall back to the channel's dist-tag when the registry was unreachable.
      const spec = newest ?? (channel === 'nightly' ? NIGHTLY_DIST_TAG : STABLE_DIST_TAG);

      const decision = decideSelfUpdate({
        installed: AGENTBOX_VERSION,
        newest,
        target: channel,
        skipSelfFlag: opts.skipSelf === true,
      });
      log.info(describeResolution(channel, newest, decision));

      const selfStep = decision.install
        ? describeSelfUpdate(method, spec)
        : decision.reason === 'flag'
          ? 'self-update: skipped (--skip-self)'
          : `self-update: skipped (${AGENTBOX_VERSION} is already the newest build)`;
      const skillsStep = opts.skipSkills
        ? 'skills: skipped (--skip-skills)'
        : 'skills: refresh agentbox-managed host skill files in ~/.claude (and Codex/OpenCode)';
      // Deliberately says nothing about WHICH plugins or which versions: this
      // line is printed by the build being replaced, whose supported SDK set is
      // the one about to change. A list computed under the old gate would be
      // exactly wrong. `agentbox plugin update --dry-run` enumerates honestly,
      // because it runs under the gate that will actually apply.
      const pluginsStep = opts.skipPlugins
        ? 'plugins: skipped (--skip-plugins)'
        : 'plugins: re-check registered provider plugins against the new SDK gate, updating any with a compatible release';
      // A deployed control box runs its own AgentBox; updating only this machine
      // leaves the two on different builds. Resolved before the confirm so the
      // plan says what will happen to the remote machine.
      const hubDecision = await resolveHubUpdate({
        skipHubFlag: opts.skipHub === true,
        // Post-update this machine is on `spec` — unless nothing is being
        // installed, in which case it stays where it is.
        targetVersion: decision.install ? (newest ?? spec) : AGENTBOX_VERSION,
      });
      const hubStep = describeHubUpdate(hubDecision);
      log.info(
        [
          'plan:',
          `  ${selfStep}`,
          `  ${skillsStep}`,
          `  ${pluginsStep}`,
          `  image: re-check ${DEFAULT_BOX_IMAGE} (left in place; its build-context fingerprint rebuilds it on the next create only if it changed)`,
          '  bases: adopt any matching cloud base bake from the control box, if one is configured',
          '  relay: stop, then respawn',
          '  app: update the menu-bar app if the published build changed (macOS, when installed)',
          ...(hubStep ? [`  ${hubStep}`] : []),
        ].join('\n'),
      );

      if (opts.dryRun) {
        outro('dry run — nothing changed');
        return;
      }

      if (!opts.yes) {
        const ok = await confirm({ message: 'Proceed with update?', initialValue: true });
        if (!ok) {
          log.info('cancelled');
          return;
        }
      }

      // Pin channel membership BEFORE installing. On nightly the newest build is
      // regularly a plain release, and once that is installed nothing in the
      // version string says "nightly" any more — without this record the next
      // launch derives `stable` and the tester is silently off the channel.
      // Written first so a failed/interrupted install can't lose the membership.
      if (opts.channel !== undefined || channel === 'nightly') {
        if (await persistChannel(channel)) {
          log.info(`channel: ${channel} (saved as update.channel)`);
        } else {
          log.warn(
            `could not save update.channel=${channel} — set it manually with \`agentbox config set update.channel ${channel} --global\``,
          );
        }
      }

      // Step 1: self-update. selfUpdated stays false unless an npm/pnpm global
      // install actually ran — that's what makes the running process stale.
      let selfUpdated = false;
      if (!decision.install) {
        log.info(
          decision.reason === 'flag'
            ? 'skipping self-update (--skip-self)'
            : `skipping self-update (${AGENTBOX_VERSION} is already the newest build)`,
        );
      } else {
        const cmd = selfUpdateCommand(method, spec);
        if (cmd === null) {
          log.info(describeSelfUpdate(method, spec));
        } else {
          log.info(`running: ${cmd.cmd} ${cmd.args.join(' ')}`);
          const code = await runInherit(cmd.cmd, cmd.args);
          if (code !== 0) {
            throw new Error(`${cmd.cmd} exited with code ${String(code)}`);
          }
          selfUpdated = true;
          log.success(`updated ${PKG} via ${cmd.cmd}`);
        }
      }

      // Step 2: the post-update refresh (skills, image, relay, tray, version
      // stamp). After a real self-update this process is the old build — its
      // bundled skills are stale and respawning the relay would relaunch the
      // stale bin — so shell out to the freshly-installed binary, which also
      // stamps its own (new) version. Otherwise this process is already
      // current: run in-process.
      if (selfUpdated) {
        const args = [
          '_post-update-refresh',
          ...(opts.skipSkills ? ['--skip-skills'] : []),
          // Conditional, not unconditional: `--channel stable` off a nightly
          // installs an OLDER build (decideSelfUpdate's `switching`), whose
          // _post-update-refresh predates this flag — and commander errors on an
          // unknown option, which would fail the whole refresh.
          ...(opts.skipPlugins ? ['--skip-plugins'] : []),
        ];
        const code = await runInherit('agentbox', args);
        if (code !== 0) {
          // Leave the stamp on the old version: the next run of the new
          // binary detects the mismatch and offers the refresh again.
          log.warn(
            `post-update refresh exited ${String(code)} — run \`agentbox self-update --skip-self\` to retry`,
          );
        }
      } else {
        await runPostUpdateRefresh({
          skipSkills: opts.skipSkills,
          skipPlugins: opts.skipPlugins,
        });
      }

      // Step 3: the deployed control box. Shelled out (not called in-process)
      // for the same reason as the refresh: after a real self-update this
      // process is the old build, and `hub update` installs *its own* version on
      // the VPS — so the old binary would deploy the version we just left.
      if (hubDecision.update) {
        const go =
          opts.yes ||
          (await confirm({
            message: `Also update the control box at ${hubDecision.url} to ${hubDecision.to}?`,
            initialValue: true,
          }));
        if (go) {
          const code = await runInherit('agentbox', ['hub', 'update', '-y']);
          if (code !== 0) {
            log.warn(
              `hub update exited ${String(code)} — the control box is still on its old build; retry with \`agentbox hub update\``,
            );
          }
        } else {
          log.info('skipped the control box — run `agentbox hub update` when you want it');
        }
      }

      await maybePromptStar({ trigger: 'self-update' });
      outro('update complete');
    } catch (err) {
      handleLifecycleError(err);
    }
  });
