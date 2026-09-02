/**
 * OpenClaw's docker behavior — the `AgentSyncModule` for a SERVICE agent.
 *
 * Two things differ from a TUI agent's module, and both follow from the agent
 * being a daemon the supervisor runs rather than a session the user attaches to:
 *
 *  - `sessionInfo` reports no session, without probing tmux. There is no tmux
 *    session to find; `activitySource: []` already stops ctl probing it, and
 *    this is the host-side half of the same answer. A probe here would spend a
 *    `docker exec` per `agentbox list` to learn nothing.
 *  - the volume is always a per-box one in practice, because two gateways
 *    sharing a state dir share one gateway identity (see `resolveOpenclawVolume`).
 *
 * There is no host config to sync in beyond what `staticPaths` already
 * describes, and everything identity-bearing is excluded there on purpose — see
 * the registry row.
 */

import { execa } from 'execa';
import {
  CONTAINER_USER,
  ensureVolume,
  volumeExists,
  type AgentSessionInfo,
  type AgentMountResult,
  type AgentVolumeChoice,
  type EnsureAgentVolumeResult,
} from '@agentbox/sandbox-docker';
import { resolveAgentSpec } from '@agentbox/sandbox-core';

const SPEC = resolveAgentSpec('openclaw');
/**
 * The single in-box dir the config volume carries, from the spec.
 *
 * ONE mount, even though the agent has two `staticPaths`: the second is
 * `relocToSubpath`'d under this root and reached through a symlink the spec's
 * `postInstall` creates, exactly as opencode's config dir is. A docker volume
 * can only be mounted once, so a second `$HOME` dir would otherwise sit in the
 * container's writable layer and be lost on re-create.
 */
const BOX_DIR = SPEC.staticPaths[0]!.boxDir;

/**
 * ALWAYS a per-box volume in practice: `runServiceAgent` passes `isolate: true`
 * unconditionally, because two OpenClaw gateways sharing a state dir share one
 * identity and its channel pairings. The shared branch is kept so this module
 * obeys the same contract as every other agent's rather than quietly ignoring
 * its argument.
 */
export function resolveOpenclawVolume(opts: {
  isolate: boolean;
  boxId: string;
}): AgentVolumeChoice {
  return { volume: opts.isolate ? `${SPEC.dockerVolume}-${opts.boxId}` : SPEC.dockerVolume };
}

/**
 * Mount the config volume at the agent's state root, and forward the run-env
 * the spec declares.
 *
 * `env` is `spec.boxRunEnv` verbatim, not a copy of its values: the cloud
 * providers merge the same field at provision time (`agentRunEnv`), and docker
 * reaching it through this module is the ONLY thing that keeps the two
 * transports agreeing. Returning `{}` here is how `OPENCLAW_WORKSPACE_DIR` went
 * missing on docker while every cloud box had it — the supervisor's onboard
 * task then wrote `~/.openclaw/workspace` instead of `/workspace`.
 */
export function buildOpenclawMounts(spec: AgentVolumeChoice): AgentMountResult {
  return {
    extraVolumes: [`${spec.volume}:${BOX_DIR}`],
    env: { ...SPEC.boxRunEnv },
    volumeName: spec.volume,
  };
}

/**
 * Create the volume if it is missing and make it writable by the box user.
 *
 * Nothing is synced from the host here: a fresh box runs the spec's own
 * `openclaw onboard` task, which is what gives it its identity. `chown` still
 * matters — a freshly created docker volume is root-owned and the box runs as
 * `vscode`, which is the user onboard and the gateway both run as.
 */
export async function ensureOpenclawVolume(
  spec: AgentVolumeChoice,
  opts: { image: string },
): Promise<EnsureAgentVolumeResult> {
  const existed = await volumeExists(spec.volume);
  await ensureVolume(spec.volume);
  if (!existed) {
    await execa('docker', [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${spec.volume}:${BOX_DIR}`,
      opts.image,
      'chown',
      '-R',
      `${CONTAINER_USER}:${CONTAINER_USER}`,
      BOX_DIR,
    ]);
  }
  return { created: !existed, synced: false };
}

/**
 * No tmux session, ever.
 *
 * The supervisor's unit state is the real answer to "is openclaw up"
 * (`agentbox openclaw status` reads it). Reporting a session here would put a
 * daemon in `agentbox list`'s AGENT column as though it were attachable, and
 * would cost a `docker exec` per listing to always answer "no".
 */
export function openclawSessionInfo(sessionName?: string): AgentSessionInfo {
  return { running: false, sessionName: sessionName ?? SPEC.sessionName, startedAt: null };
}
