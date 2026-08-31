/**
 * The demo agent's docker behavior — deliberately the smallest complete
 * implementation of `AgentSyncModule`.
 *
 * It is here to be READ. If you are adding an agent, this file plus
 * `index.ts` plus a row in `@agentbox/agent-registry/src/specs/` is the whole
 * job; nothing outside this package should need editing, and the test in
 * `@agentbox/agent-modules` fails if that stops being true.
 *
 * Its "agent" is a login shell, so it needs no network, no npm package and no
 * credentials that can expire. Swap `binary` and `install` on the spec row and
 * the same shape carries a real agent.
 */

import { execa } from 'execa';
import {
  buildTermSafeTmuxExec,
  buildTmuxSessionArgs,
  CONTAINER_USER,
  ensureVolume,
  volumeExists,
  type AgentSessionInfo,
  type AgentMountResult,
  type AgentVolumeChoice,
  type EnsureAgentVolumeResult,
} from '@agentbox/sandbox-docker';
import { resolveAgentSpec } from '@agentbox/sandbox-core';

const SPEC = resolveAgentSpec('example');
/** The in-box config dir, from the spec — never a second copy of the path. */
const BOX_DIR = SPEC.staticPaths[0]!.boxDir;

/**
 * The shared volume, or a per-box one when the caller asked for isolation.
 * Same rule every agent follows; the shared name is `spec.dockerVolume`.
 */
export function resolveExampleVolume(opts: { isolate: boolean; boxId: string }): AgentVolumeChoice {
  return {
    volume: opts.isolate ? `${SPEC.dockerVolume}-${opts.boxId}` : SPEC.dockerVolume,
  };
}

/** Mount the config volume at the agent's box dir. No env to forward. */
export function buildExampleMounts(spec: AgentVolumeChoice): AgentMountResult {
  return {
    extraVolumes: [`${spec.volume}:${BOX_DIR}`],
    env: {},
    volumeName: spec.volume,
  };
}

/**
 * Create the volume if it is missing and make it writable by the box user.
 *
 * Nothing is synced from the host: this agent has no host config to carry in,
 * which is the honest answer for an agent that keeps no state. `chown` still
 * matters — a freshly created docker volume is root-owned, and the box runs as
 * `vscode`.
 */
export async function ensureExampleVolume(
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

/** Probe the agent's tmux session. Mirrors every other agent's version. */
export async function exampleSessionInfo(container: string): Promise<AgentSessionInfo> {
  const r = await execa(
    'docker',
    [
      'exec',
      container,
      'tmux',
      'display-message',
      '-p',
      '-t',
      SPEC.sessionName,
      '#{session_created}',
    ],
    { reject: false },
  );
  if (r.exitCode !== 0) {
    return { running: false, sessionName: SPEC.sessionName, startedAt: null };
  }
  const secs = Number.parseInt(r.stdout.trim(), 10);
  return {
    running: true,
    sessionName: SPEC.sessionName,
    startedAt: Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : null,
  };
}

/** Start the agent in a tmux session, under the shared TERM guard. */
export async function startExampleSession(container: string): Promise<void> {
  await execa('docker', [
    'exec',
    '--user',
    CONTAINER_USER,
    container,
    'tmux',
    'new-session',
    '-d',
    '-s',
    SPEC.sessionName,
    '-c',
    '/workspace',
    SPEC.binary,
    '-l',
    ...buildTmuxSessionArgs(SPEC.sessionName),
  ]);
}

/** The `docker exec` argv that attaches a terminal to the session. */
export function buildExampleAttachArgv(container: string): string[] {
  return buildTermSafeTmuxExec({
    container,
    user: CONTAINER_USER,
    tmuxScript: 'tmux attach -t "$1"',
    positionals: [SPEC.sessionName],
  });
}
