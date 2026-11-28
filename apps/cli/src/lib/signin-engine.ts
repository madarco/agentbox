/**
 * Where a hub-driven sign-in's docker runs (`_account-login-worker`).
 *
 * `local`: this machine's docker, exactly as before: the agent's image built
 * or pulled here, its scratch volume seeded by the agent's runtime from this
 * machine's config, and the login stored into the account's own volume too,
 * which this machine's docker boxes mount.
 *
 * `hub`: a control box. The hub runs in a container with no docker, so the
 * sign-in runs on the VPS's engine (remote-docker alias `hub`). Its boxes are
 * remote-docker or cloud boxes, which never mount an account volume: they are
 * seeded from the hub's account store and kept current by the renew fan-out.
 * So the sign-in there is a throwaway login container on a scratch volume, and
 * the store is the only place the login lands.
 */
import { homedir } from 'node:os';
import { allAgentSettings, loadEffectiveConfig } from '@agentbox/config';
import type { AgentCliSpec } from '@agentbox/cli-kit';
import { ensureImage, localDockerRun, type DockerRun } from '@agentbox/sandbox-docker';
import {
  openRemoteDockerEngine,
  removeRemoteSigninVolume,
  resolveSigninDocker,
  type RemoteDockerEngine,
} from '@agentbox/sandbox-remote-docker';
import { removeDockerVolume } from './login-fanout.js';

export interface SigninEngine {
  where: 'local' | 'hub';
  /** The agent's image on this engine; returns its ref. */
  ensureImage(agentId: string, log: (line: string) => void): Promise<string>;
  /** Create the scratch volume the login writes (local: seeded like the account's). */
  prepareVolume(a: AgentCliSpec, volume: string, image: string, account: string): Promise<void>;
  /** One-shot `docker` runs: volume reads, the binding's checks. */
  run: DockerRun;
  /** The pty command for the login's `docker run -it` argv; undefined = `docker` here. */
  loginCommand(argv: string[], name: string): { file: string; args: string[] } | undefined;
  /** Remove the scratch volume (and on the hub engine, the login container named after it). */
  removeVolume(volume: string): Promise<boolean>;
  /**
   * Whether this engine holds the account volumes boxes mount, which the
   * stored login must then be written into as well.
   */
  hostsAccountVolumes: boolean;
}

/** The docker argv with `--name <name>` right after `run`. Pure. */
export function withContainerName(argv: readonly string[], name: string): string[] {
  if (argv[0] !== 'run') throw new Error(`not a docker run argv: ${argv.slice(0, 2).join(' ')}`);
  return ['run', '--name', name, ...argv.slice(1)];
}

export function localSigninEngine(): SigninEngine {
  return {
    where: 'local',
    async ensureImage(agentId, log) {
      // The hub's own machine config: the hub's cwd is no project of the user's.
      const cfg = await loadEffectiveConfig(homedir());
      const { ref } = await ensureImage(cfg.effective.box.image, {
        agents: [agentId],
        onProgress: log,
      });
      return ref;
    },
    async prepareVolume(a, volume, image, account) {
      // `account` strips the host's login and account state from the seed.
      await a.runtime.ensureVolume({ volume }, { syncFromHost: true, image, account });
    },
    run: localDockerRun,
    loginCommand: () => undefined,
    removeVolume: (volume) => removeDockerVolume(volume),
    hostsAccountVolumes: true,
  };
}

export function hubSigninEngine(engine: RemoteDockerEngine): SigninEngine {
  const { run } = engine;
  return {
    where: 'hub',
    async ensureImage(agentId, log) {
      const cfg = await loadEffectiveConfig(homedir());
      return engine.ensureAgentImage([agentId], {
        agentSettings: allAgentSettings(cfg.effective),
        onLog: log,
      });
    },
    async prepareVolume(a, volume, image) {
      // Not seeded from this machine: the hub's container holds no agent
      // config of the user's. Only the first-run state the agent asks for.
      const r = await run(['volume', 'create', volume]);
      if (r.exitCode !== 0) {
        throw new Error(
          `could not create the sign-in volume on ${engine.alias}: ${r.stderr.trim() || `exit ${String(r.exitCode)}`}`,
        );
      }
      await a.runtime.seedLoginVolume?.(volume, image, run);
    },
    run,
    // Named, so a login whose ssh session died (the worker killed mid-flow)
    // leaves a container the cleanup can find by the volume's name.
    loginCommand: (argv, name) => engine.ttyCommand(withContainerName(argv, name)),
    removeVolume: (volume) => removeRemoteSigninVolume(run, volume),
    hostsAccountVolumes: false,
  };
}

/** The engine this process signs in on, or an error saying why there is none. */
export async function resolveSigninEngine(): Promise<SigninEngine> {
  const where = resolveSigninDocker();
  if (where === 'local') return localSigninEngine();
  if (where === 'hub') return hubSigninEngine(await openRemoteDockerEngine());
  throw new Error(
    'this hub has no docker to run the sign-in in: there is no docker CLI here and no remote-docker engine `hub` is registered (on a control box, `agentbox hub update` re-registers it)',
  );
}
