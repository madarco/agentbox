/**
 * `docker:hub` — the control box's own docker engine, as a target on this machine.
 *
 * Deploying a control box otherwise costs the user the docker-shaped box
 * entirely: `dockerProvidersHidden` turns docker off here (a box built on the
 * laptop dies with the laptop), and every remaining provider needs a cloud
 * credential. But the control box itself runs docker — that is what the hub runs
 * on — so it is exactly the always-on engine the gate wants.
 *
 * Two halves, deliberately independent:
 *   - the local host alias `hub` -> the `agentbox-hub` ssh alias the deploy
 *     already writes, so this machine can drive that engine directly too
 *     (`agentbox docker:hub …`, `prepare`'s local fallback);
 *   - the default flip, which only needs the CONTROL BOX to know the engine —
 *     creates route there over the API, no ssh from here at all. That is what
 *     makes this work on a second machine pointed at a hub it never deployed.
 */

import { homedir } from 'node:os';
import { loadEffectiveConfig, setConfigValue, unsetConfigValue } from '@agentbox/config';
import { AGENTBOX_HUB_SSH_ALIAS } from '@agentbox/sandbox-core';
import { getHostAlias, removeHostAlias, upsertHostAlias } from '@agentbox/sandbox-remote-docker';
import { readDeployRecord } from './deploy-hetzner.js';
import { controlBoxKnowsHost } from './remote-docker-share.js';
import { controlBoxIsThisMachine } from './remote-hub.js';

/**
 * The host alias for the control box's engine. Fixed, like the ssh alias it
 * points at: there is at most one control box per machine, and `docker:hub`
 * reading as "my hub's docker" is the whole point.
 */
export const HUB_DOCKER_ALIAS = 'hub';

/** What `box.provider` becomes when the hub's engine takes over as the default. */
export const HUB_PROVIDER_SPEC = `docker:${HUB_DOCKER_ALIAS}`;

/**
 * Register `hub` and, when the previous default was plain docker, make it the
 * new one. Idempotent; safe to run after every setup/deploy/update.
 *
 * Never overwrites a `hub` alias the user pointed somewhere else — that is their
 * name, and silently repointing it would move every box created against it.
 */
export async function ensureHubDockerTarget(log: (line: string) => void): Promise<void> {
  // A control box that IS this machine already has a perfectly good local docker;
  // `dockerProviderRefusal` stops gating it, and there is no engine to alias.
  if (await controlBoxIsThisMachine()) return;

  const record = await readDeployRecord().catch(() => null);
  if (record?.ip && record.sshKeyDir) {
    const existing = getHostAlias(HUB_DOCKER_ALIAS);
    if (!existing) {
      upsertHostAlias(HUB_DOCKER_ALIAS, AGENTBOX_HUB_SSH_ALIAS);
      log(`registered the control box's docker engine as \`${HUB_DOCKER_ALIAS}\``);
    } else if (existing.ssh !== AGENTBOX_HUB_SSH_ALIAS) {
      log(
        `note: the remote-docker host \`${HUB_DOCKER_ALIAS}\` already points at ${existing.ssh}, so it was left alone`,
      );
    }
  }

  const cfg = await loadEffectiveConfig(homedir()).catch(() => null);
  if (!cfg) return;
  const current = cfg.layers.global.values.box?.provider;
  // Only take over from docker (or from nothing). A user who pinned a cloud
  // provider chose it; a control box arriving does not change that.
  if (current !== undefined && current !== 'docker') return;
  if (!(await controlBoxKnowsHost(HUB_DOCKER_ALIAS, cfg.effective))) return;
  await setConfigValue('global', 'box.provider', HUB_PROVIDER_SPEC, homedir(), { raw: true });
  log(
    `new boxes now default to \`${HUB_PROVIDER_SPEC}\` — your control box's own docker engine, so they keep running with this machine off. ` +
      'Change it with `agentbox config set box.provider <name>`.',
  );
}

/**
 * Undo {@link ensureHubDockerTarget}. Called when the control box goes away, so
 * a destroyed hub doesn't leave `box.provider` pointing at an engine that no
 * longer exists.
 */
export async function removeHubDockerTarget(log: (line: string) => void): Promise<void> {
  const cfg = await loadEffectiveConfig(homedir()).catch(() => null);
  if (cfg?.layers.global.values.box?.provider === HUB_PROVIDER_SPEC) {
    await unsetConfigValue('global', 'box.provider', homedir());
    log('box.provider was `docker:hub`; cleared it (new boxes go back to local docker)');
  }
  // Only ours — an alias the user re-pointed is theirs to keep.
  const existing = getHostAlias(HUB_DOCKER_ALIAS);
  if (existing && existing.ssh === AGENTBOX_HUB_SSH_ALIAS) removeHostAlias(HUB_DOCKER_ALIAS);
}
