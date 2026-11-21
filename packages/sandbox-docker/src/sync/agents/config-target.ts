/**
 * Where `<agent> start` writes an agent's host config for one box.
 *
 * An agent's config volume is mounted at create time, and only for the agents
 * that box was created for. Docker cannot add a mount to an existing container,
 * so a box created for claude has no codex volume, and `codex start` in it used
 * to skip the host sync entirely — the session came up with whatever the
 * install left behind (default provider, default model).
 *
 * The fix keeps the one sync pipeline every agent already has (it writes a
 * VOLUME, through a throwaway helper container) and changes only what that
 * volume is:
 *
 *   - mounted: the container really mounts a volume at the agent's config dir
 *     (checked against `docker inspect`, not the box record — claude's record
 *     falls back to the shared volume whether or not it is mounted). Sync into
 *     it directly; `flush`/`release` are no-ops. This is the ordinary path.
 *   - staged: no such mount. A per-box staging volume is filled from the
 *     container's current config dir, the caller syncs into it exactly as it
 *     would a mounted volume (so merge-style steps like codex's `config.toml`
 *     reconcile see the in-box state), and `flush` mirrors the result into the
 *     container's config dir with `rsync --delete`, as root, in one pass. The
 *     staging volume started as a copy of that dir, so the mirror deletes only
 *     what the sync itself removed (claude's marketplace prunes), exactly as it
 *     would have on a mounted volume.
 *
 * The staging volume holds credentials, so it is dropped on every exit path:
 * `release` in the caller's `finally`, a SIGINT/SIGTERM handler while it
 * exists, and a sweep of any leftover at the next staged start.
 */

import { execa } from 'execa';
import { streamTarPipe } from '../../box-cp.js';
import { ensureVolume, inspectContainer } from '../../docker.js';
import { agentSyncModule } from './module.js';
import { CONTAINER_USER } from './shared.js';
import type { AgentId } from '@agentbox/core';

export interface AgentConfigTarget {
  /** The volume to sync into: the mounted one, or the staging volume. */
  volume: string;
  /** True when `volume` is mounted at the agent's config dir in the container. */
  mounted: boolean;
  /** Mirror the staging volume into the container's config dir. No-op when mounted. */
  flush(): Promise<void>;
  /** Drop the staging volume. No-op when mounted. Never throws. */
  release(): Promise<void>;
}

const PROBE_VOLUME = '__agentbox_probe__';
const STAGE_MOUNT = '/stage';

/**
 * The in-box directory an agent's config volume is mounted at, from the agent's
 * own `buildMounts` (so a plugin agent needs no entry here). Undefined when the
 * agent has no docker sync module or mounts no volume.
 */
export function agentConfigDir(agent: AgentId): string | undefined {
  const mod = agentSyncModule(agent);
  if (!mod) return undefined;
  const { extraVolumes } = mod.buildMounts({ volume: PROBE_VOLUME }, {});
  for (const spec of extraVolumes) {
    const parts = spec.split(':');
    if (parts[0] === PROBE_VOLUME && parts[1]) return parts[1];
  }
  return undefined;
}

/** Per-box, per-agent staging volume. `agentbox-` prefixed so prune sees it. */
export function agentConfigStagingVolume(agent: AgentId, boxId: string): string {
  return `agentbox-${agent}-config-stage-${boxId}`;
}

interface InspectedMount {
  Type?: string;
  Name?: string;
  Destination?: string;
}

/** The name of the volume mounted at `dir`, '' when nothing is, null when unknown. */
async function mountedVolumeAt(container: string, dir: string): Promise<string | null> {
  const insp = (await inspectContainer(container)) as { Mounts?: InspectedMount[] } | null;
  if (!insp) return null;
  const hit = (insp.Mounts ?? []).find((m) => m.Destination === dir && m.Type === 'volume');
  return hit?.Name ?? '';
}

function noopTarget(volume: string): AgentConfigTarget {
  return { volume, mounted: true, flush: async () => {}, release: async () => {} };
}

function quoteSh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve where to sync `agent`'s config for this box. `recordVolume` is what
 * the box record says (the agent runtime's `resolveConfigVolume`); it is used
 * only for an agent that mounts no config dir. When the container cannot be
 * inspected this throws rather than guess: the record can name a volume the
 * container does not mount (claude's shared-volume fallback), and syncing into
 * that would report success while the box keeps its old config.
 *
 * `stage: false` (attach, `--no-sync-config`) never stages: with no mounted
 * volume there is nothing to write, which is what those paths did before.
 *
 * Returns undefined when there is nothing to sync into at all.
 */
export async function openAgentConfigTarget(opts: {
  agent: AgentId;
  container: string;
  boxId: string;
  image: string;
  recordVolume: string | undefined;
  stage: boolean;
}): Promise<AgentConfigTarget | undefined> {
  const dir = agentConfigDir(opts.agent);
  const fallback = opts.recordVolume ? noopTarget(opts.recordVolume) : undefined;
  if (!dir) return fallback;
  const mounted = await mountedVolumeAt(opts.container, dir);
  if (mounted === null) {
    throw new Error(
      `could not inspect ${opts.container} to find what is mounted at ${dir}; ` +
        `not syncing ${opts.agent} config. Check that the container exists (docker ps -a).`,
    );
  }
  if (mounted) return noopTarget(mounted);
  if (!opts.stage) return undefined;

  const volume = agentConfigStagingVolume(opts.agent, opts.boxId);
  // Hooked before the volume exists, so a Ctrl-C while it is being created or
  // filled cannot leak it. `on`, not `once`: execa's signal-exit re-raises the
  // signal as soon as it is the only listener left, which would kill the
  // process before the removal ran. A second Ctrl-C exits at once.
  let interrupted = false;
  const onSignal = (sig: NodeJS.Signals): void => {
    const code = sig === 'SIGINT' ? 130 : 143;
    if (interrupted) process.exit(code);
    interrupted = true;
    void dropVolume(volume).finally(() => process.exit(code));
  };
  for (const sig of SIGNALS) process.on(sig, onSignal);
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    for (const sig of SIGNALS) process.removeListener(sig, onSignal);
    await dropVolume(volume);
  };
  try {
    // A leftover from an interrupted start would leak stale files into this one.
    await dropVolume(volume);
    await ensureVolume(volume);
    // Root in the helper so `-p` keeps the box user's ownership; the in-box
    // side runs as the box user, which is who owns the config dir.
    await pipeOrThrow(
      `could not stage ${opts.agent} config from ${opts.container}:${dir}`,
      [
        'exec',
        '--user',
        CONTAINER_USER,
        opts.container,
        'sh',
        '-c',
        `mkdir -p ${quoteSh(dir)} && tar -C ${quoteSh(dir)} -cf - .`,
      ],
      [
        'run',
        '--rm',
        '-i',
        '--user',
        '0',
        '-v',
        `${volume}:${STAGE_MOUNT}`,
        opts.image,
        'tar',
        '-C',
        STAGE_MOUNT,
        '-xpf',
        '-',
      ],
    );
  } catch (err) {
    await release();
    throw err;
  }

  return {
    volume,
    mounted: false,
    release,
    flush: () =>
      pipeOrThrow(
        `could not copy ${opts.agent} config into ${opts.container}:${dir}`,
        [
          'run',
          '--rm',
          '--user',
          '0',
          '-v',
          `${volume}:${STAGE_MOUNT}:ro`,
          opts.image,
          'tar',
          '-C',
          STAGE_MOUNT,
          '-cf',
          '-',
          '.',
        ],
        // Unpacked as root into a scratch dir (keeps owners and symlinks such
        // as codex's auth.json link), then mirrored in one pass. chown by name:
        // the box user's uid differs between providers.
        [
          'exec',
          '-i',
          '--user',
          '0',
          opts.container,
          'sh',
          '-c',
          MIRROR_SCRIPT,
          'sh',
          dir,
          CONTAINER_USER,
        ],
      ),
  };
}

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * `docker volume rm`, retried while a helper that was just interrupted still
 * holds the volume (its `--rm` cleanup lags the client's exit). Never throws.
 */
async function dropVolume(volume: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const r = await execa('docker', ['volume', 'rm', volume], { reject: false });
    if (r.exitCode === 0 || /no such volume/i.test(String(r.stderr))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const MIRROR_SCRIPT = [
  'set -e',
  's=$(mktemp -d /tmp/agentbox-config-XXXXXXXX)',
  `trap 'rm -rf "$s"' EXIT INT TERM HUP`,
  'tar -C "$s" -xf -',
  'mkdir -p "$1"',
  'rsync -a --delete -- "$s/" "$1/"',
  'chown -R "$2:" "$1"',
].join('\n');

async function pipeOrThrow(what: string, from: string[], into: string[]): Promise<void> {
  const [a, b] = await streamTarPipe('docker', from, 'docker', into);
  if (a.exitCode !== 0 || b.exitCode !== 0) {
    const err = a.exitCode !== 0 ? a.stderr : b.stderr;
    const text = typeof err === 'string' ? err : Buffer.from(err ?? []).toString('utf8');
    throw new Error(`${what}: ${text.trim().slice(0, 500)}`);
  }
}
