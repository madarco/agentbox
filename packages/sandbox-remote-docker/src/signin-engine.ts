/**
 * The docker engine a hub-driven sign-in runs on when the hub's machine has no
 * docker of its own: a control box, whose hub runs in a container with no
 * docker CLI and no socket, signs in on the VPS's engine, which the deploy
 * registered as the host alias `hub` (see `HUB_ENGINE_ALIAS`).
 *
 * Everything rides the same chokepoint as a remote-docker box: the alias's
 * ControlMaster (`engine:<alias>`, shared with `prepare`), a login shell, and
 * `quoteShellArgv`. The sign-in needs four things from it: one-shot `docker`
 * runs (volume reads, the credential check, claude's warm-up), an interactive
 * `docker run -it` under a pty, the agent's image, and the scratch volume.
 */
import { delimiter, join } from 'node:path';
import { accessSync, constants } from 'node:fs';
import { derivedAgentDockerfile, type DockerRun } from '@agentbox/sandbox-docker';
import { variantFingerprint, type AgentSettingsMap } from '@agentbox/sandbox-core';
import { getHostAlias } from './hosts-registry.js';
import { ensureRemoteImage, remoteImageRef } from './image.js';
import {
  dockerOnRemote,
  dockerOnRemoteTtyCommand,
  dockerOnRemoteWithInput,
  ensureTunnel,
  HUB_ENGINE_ALIAS,
} from './remote-docker.js';
import { parseRemoteTarget } from './target.js';

export interface RemoteDockerEngine {
  alias: string;
  run: DockerRun;
  /** The pty command for an interactive `docker <argv…>` on the engine. */
  ttyCommand(argv: string[]): { file: string; args: string[] };
  /** The box image with `agents` installed, present on the engine; returns its ref. */
  ensureAgentImage(
    agents: readonly string[],
    opts?: { agentSettings?: AgentSettingsMap; onLog?: (line: string) => void },
  ): Promise<string>;
}

/** Where a hub sign-in's docker runs. */
export type SigninDockerChoice = 'local' | 'hub' | 'none';

/**
 * Local docker whenever its CLI is here (a laptop hub, or a hub exposed on a
 * machine with docker: unchanged); the registered `hub` engine only when there
 * is no docker CLI at all (the control box's hub container). A docker CLI whose
 * daemon is down stays local, so a stopped Docker Desktop never sends a
 * laptop's sign-in to its control box. Pure.
 */
export function chooseSigninDocker(o: {
  dockerOnPath: boolean;
  hubRegistered: boolean;
}): SigninDockerChoice {
  if (o.dockerOnPath) return 'local';
  return o.hubRegistered ? 'hub' : 'none';
}

/** Whether an executable named `name` is on `PATH`. */
export function commandOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

/** {@link chooseSigninDocker} for this process. */
export function resolveSigninDocker(): SigninDockerChoice {
  return chooseSigninDocker({
    dockerOnPath: commandOnPath('docker'),
    hubRegistered: getHostAlias(HUB_ENGINE_ALIAS) !== undefined,
  });
}

/**
 * The remote ref of the agent layer: its own fingerprint (the base's context
 * sha folded with the agents and their settings), so "present on the engine"
 * means "up to date", exactly like the base ref. Pure.
 */
export function remoteAgentImageRef(
  contextSha256: string,
  agents: readonly string[],
  agentSettings?: AgentSettingsMap,
): string {
  return remoteImageRef(variantFingerprint(contextSha256, { agents, agentSettings }));
}

/** Open (or reuse) the ControlMaster to a registered engine alias. */
export async function openRemoteDockerEngine(
  alias: string = HUB_ENGINE_ALIAS,
): Promise<RemoteDockerEngine> {
  const remote = parseRemoteTarget(alias);
  const target = await ensureTunnel(`engine:${remote.spec}`, remote);
  const run: DockerRun = (argv, opts = {}) =>
    opts.input !== undefined
      ? dockerOnRemoteWithInput(target, argv, opts.input, {
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        })
      : dockerOnRemote(target, argv, {
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        });
  return {
    alias,
    run,
    ttyCommand: (argv) => dockerOnRemoteTtyCommand(target, argv),
    async ensureAgentImage(agents, opts = {}) {
      const log = opts.onLog ?? ((): void => {});
      // The same agentless base a remote-docker create provisions (no agent
      // settings fold into it: it installs no agent), so an engine that has
      // run a box already has it.
      const base = await ensureRemoteImage(target, { onLog: log });
      if (!base.contextSha256) throw new Error('remote-docker: the base image has no fingerprint');
      const ref = remoteAgentImageRef(base.contextSha256, agents, opts.agentSettings);
      if ((await run(['image', 'inspect', ref])).exitCode === 0) return ref;
      log(`[image] adding ${agents.join(', ')} to ${base.ref} on ${alias}`);
      const dockerfile = derivedAgentDockerfile(base.ref, agents, opts.agentSettings);
      // `build -` reads the Dockerfile itself from stdin: the layer is FROM +
      // RUN only, so it needs no context (and no `-f`, which buildx refuses
      // alongside a stdin context).
      const res = await dockerOnRemoteWithInput(
        target,
        ['build', '-t', ref, '-'],
        dockerfile.join('\n') + '\n',
        { timeoutMs: 1_800_000, onLine: (line) => log(`[image] ${line}`) },
      );
      if (res.exitCode !== 0) {
        const tail = (res.stderr.trim() || res.stdout.trim()).split('\n').slice(-5).join('\n');
        throw new Error(
          `remote-docker: building the ${agents.join(', ')} image on ${alias} failed (exit ${String(res.exitCode)}): ${tail}`,
        );
      }
      log(`[image] built ${ref}`);
      return ref;
    },
  };
}

/**
 * Remove a sign-in's scratch volume on a remote engine, and every container
 * still using it first: the login container (named after the volume) and any
 * warm-up whose ssh timed out (a timeout ends the local ssh only, not the
 * remote `docker run`). Retried while a dying container still holds it.
 */
export async function removeRemoteSigninVolume(
  run: DockerRun,
  volume: string,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 10;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    const users = await run(['ps', '-aq', '--filter', `volume=${volume}`]).catch(() => null);
    const ids = users?.exitCode === 0 ? users.stdout.split('\n').filter(Boolean) : [];
    await run(['rm', '-f', volume, ...ids]).catch(() => undefined);
    const r = await run(['volume', 'rm', '-f', volume]).catch(() => null);
    if (r?.exitCode === 0) return true;
    if (i < attempts - 1) await sleep(1_000);
  }
  return false;
}
