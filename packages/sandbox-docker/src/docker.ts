import { execa, type Result } from 'execa';

export interface DockerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ContainerRuntimeState = 'running' | 'paused' | 'stopped' | 'missing';

export async function dockerInfo(): Promise<void> {
  const result: Result = await execa('docker', ['info'], { reject: false });
  if (result.exitCode !== 0) {
    throw new Error(
      `docker info failed (exit ${String(result.exitCode)}). Is the Docker daemon running?\n${String(result.stderr)}`,
    );
  }
}

/**
 * Engine-agnostic resource ceilings. Memory in bytes, cpus fractional, disk a
 * raw engine-native size string. `null`/absent = unlimited.
 */
export interface BoxLimitSpec {
  memoryBytes?: number | null;
  cpus?: number | null;
  pidsLimit?: number | null;
  disk?: string | null;
}

export interface RunBoxSpec {
  name: string;
  image: string;
  extraVolumes?: string[];
  env?: Record<string, string>;
  limits?: BoxLimitSpec;
  /**
   * docker `-p` mappings to forward host ports into the container. `hostPort: 0`
   * lets Docker pick a free ephemeral port; resolve it back with
   * {@link publishedHostPort}. `hostIp` defaults to all interfaces — pin it to
   * `127.0.0.1` for loopback-only exposure.
   */
  portMappings?: Array<{ hostPort: number; containerPort: number; hostIp?: string }>;
}

export async function runBox(spec: RunBoxSpec): Promise<string> {
  const args: string[] = [
    'run',
    '-d',
    '--name',
    spec.name,
    '--hostname',
    spec.name,
    '--cap-add=SYS_ADMIN',
    // dockerd inside the box (always-on, see launchDockerdDaemon) needs
    // NET_ADMIN to set up its bridge + iptables NAT for inner containers.
    // seccomp:unconfined is required because the default profile blocks
    // syscalls (notably keyctl, clone3 in some kernels) that nested containers
    // need. Both are scoped to the outer box's namespaces — inner containers
    // can't escape it. We still avoid --privileged for cloud portability.
    '--cap-add=NET_ADMIN',
    // /dev/fuse + SYS_ADMIN + apparmor:unconfined used to be required for the
    // outer /workspace FUSE overlay. That overlay is gone, but they're still
    // load-bearing for the *inner* dockerd's storage driver, which
    // agentbox-dockerd-start selects at runtime: SYS_ADMIN lets it `mount -t
    // overlay` for the preferred kernel-native overlay2 driver, and /dev/fuse
    // + SYS_ADMIN + apparmor:unconfined are needed for the fuse-overlayfs
    // fallback (used where overlay2's runtime probe fails).
    '--device=/dev/fuse',
    '--security-opt=apparmor:unconfined',
    '--security-opt=seccomp=unconfined',
    // cgroup v2 + DinD: with --cgroupns=host (the OrbStack default) the
    // outer container sees the host's read-only cgroup hierarchy at
    // /sys/fs/cgroup, so the inner dockerd can't `mkdir /sys/fs/cgroup/docker`
    // for its own slice and inner `docker run` fails with "read-only file
    // system". Private gives the box its own writable cgroup namespace; runc
    // creates the docker slice there and inner containers nest under it.
    '--cgroupns=private',
    // Make the host reachable from inside the container at the well-known DNS
    // name host.docker.internal. Docker Desktop / OrbStack ship this alias by
    // default; on Linux native Docker it requires this explicit flag (no-op
    // on the macOS engines). Boxes use it to reach the host relay process.
    '--add-host=host.docker.internal:host-gateway',
  ];
  // Nested AgentBox-in-AgentBox dev only: the outer sandbox lacks
  // CAP_SYS_PTRACE, so the inner dockerd can't bind-mount /proc/<pid>/ns/net
  // for a non-root container init (image default USER is vscode → uid 1000).
  // Forcing init to uid 0 makes init's /proc readable by daemon (same uid) so
  // netns setup succeeds. Gated on AGENTBOX=1 so normal-host runs are
  // unaffected. shell/exec flows pass --user explicitly (CONTAINER_USER),
  // so this only changes which uid the supervisor + service tree run as
  // inside a nested box.
  if (process.env.AGENTBOX === '1') {
    args.push('--user', '0');
  }
  const lim = spec.limits;
  if (lim) {
    if (lim.memoryBytes && lim.memoryBytes > 0) {
      args.push('--memory', String(Math.floor(lim.memoryBytes)));
    }
    if (lim.cpus && lim.cpus > 0) {
      args.push('--cpus', String(lim.cpus));
    }
    if (lim.pidsLimit && lim.pidsLimit > 0) {
      args.push('--pids-limit', String(Math.floor(lim.pidsLimit)));
    }
    // Best-effort: a no-op on overlay2 / the macOS engines. createBox() drops
    // this on those drivers (and warns) so `docker run` doesn't hard-error.
    if (lim.disk) {
      args.push('--storage-opt', `size=${lim.disk}`);
    }
  }
  for (const v of spec.extraVolumes ?? []) {
    args.push('-v', v);
  }
  for (const pm of spec.portMappings ?? []) {
    const host = pm.hostIp ? `${pm.hostIp}:${String(pm.hostPort)}` : String(pm.hostPort);
    args.push('-p', `${host}:${String(pm.containerPort)}`);
  }
  for (const [k, val] of Object.entries(spec.env ?? {})) {
    args.push('-e', `${k}=${val}`);
  }
  args.push(spec.image, 'sleep', 'infinity');

  const { stdout } = await execa('docker', args);
  return stdout.trim();
}

/**
 * The engine's storage driver (`overlay2`, `fuse-overlayfs`, `btrfs`, …).
 * `--storage-opt size=` is only enforced by devicemapper/btrfs/zfs/windowsfilter
 * — a no-op everywhere the macOS engines run. Empty string on probe failure.
 */
export async function dockerStorageDriver(): Promise<string> {
  const result = await execa('docker', ['info', '--format', '{{.Driver}}'], { reject: false });
  if (result.exitCode !== 0) return '';
  return (result.stdout ?? '').trim();
}

export async function execInBox(
  container: string,
  cmd: string[],
  opts: { user?: string; detach?: boolean; timeoutMs?: number } = {},
): Promise<DockerExecResult> {
  const args: string[] = ['exec'];
  if (opts.detach) args.push('-d');
  if (opts.user) args.push('--user', opts.user);
  args.push(container, ...cmd);
  const result = await execa('docker', args, {
    reject: false,
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export async function removeContainer(container: string): Promise<void> {
  await execa('docker', ['rm', '-f', container], { reject: false });
}

export async function removeVolume(name: string): Promise<void> {
  await execa('docker', ['volume', 'rm', name], { reject: false });
}

/**
 * Best-effort `docker image rm`. Returns true when the image was actually
 * removed, false when it was already absent (or removal failed). `-f` is
 * passed by default so a stale tagged image with no live containers goes away
 * even if other tags point at the same layers.
 */
export async function removeImage(ref: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const args = ['image', 'rm'];
  if (opts.force !== false) args.push('-f');
  args.push(ref);
  const result = await execa('docker', args, { reject: false });
  return result.exitCode === 0;
}

export async function containerExists(name: string): Promise<boolean> {
  const result = await execa('docker', ['container', 'inspect', '--format', '{{.Id}}', name], {
    reject: false,
  });
  return result.exitCode === 0;
}

export async function volumeExists(name: string): Promise<boolean> {
  const result = await execa('docker', ['volume', 'inspect', name], { reject: false });
  return result.exitCode === 0;
}

export async function ensureVolume(name: string): Promise<void> {
  if (await volumeExists(name)) return;
  await execa('docker', ['volume', 'create', name]);
}

export async function networkExists(name: string): Promise<boolean> {
  const result = await execa('docker', ['network', 'inspect', name], { reject: false });
  return result.exitCode === 0;
}

export async function ensureNetwork(name: string): Promise<void> {
  if (await networkExists(name)) return;
  await execa('docker', ['network', 'create', name]);
}

export async function removeNetwork(name: string): Promise<void> {
  await execa('docker', ['network', 'rm', name], { reject: false });
}

export async function containerIsRunning(name: string): Promise<boolean> {
  return (await inspectContainerStatus(name)) === 'running';
}

export async function pauseContainer(name: string): Promise<void> {
  await execa('docker', ['pause', name]);
}

export async function unpauseContainer(name: string): Promise<void> {
  await execa('docker', ['unpause', name]);
}

export async function stopContainer(name: string): Promise<void> {
  await execa('docker', ['stop', name]);
}

export async function startContainer(name: string): Promise<void> {
  await execa('docker', ['start', name]);
}

export async function inspectContainerStatus(name: string): Promise<ContainerRuntimeState> {
  const result = await execa('docker', ['inspect', '--format', '{{.State.Status}}', name], {
    reject: false,
  });
  if (result.exitCode !== 0) return 'missing';
  const status = (result.stdout ?? '').trim();
  switch (status) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'created':
    case 'exited':
    case 'dead':
    case 'restarting':
    case 'removing':
      return 'stopped';
    default:
      return 'missing';
  }
}

export async function inspectContainer(name: string): Promise<unknown | null> {
  const result = await execa('docker', ['inspect', name], { reject: false });
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout ?? 'null') as unknown[];
    return Array.isArray(parsed) ? (parsed[0] ?? null) : null;
  } catch {
    return null;
  }
}

export async function inspectVolumeMountpoint(name: string): Promise<string | null> {
  const result = await execa('docker', ['volume', 'inspect', '--format', '{{.Mountpoint}}', name], {
    reject: false,
  });
  if (result.exitCode !== 0) return null;
  return (result.stdout ?? '').trim() || null;
}

const AGENTBOX_PREFIX = 'agentbox-';

export async function listAgentboxContainers(): Promise<string[]> {
  const result = await execa(
    'docker',
    ['ps', '-a', '--filter', `name=^${AGENTBOX_PREFIX}`, '--format', '{{.Names}}'],
    { reject: false },
  );
  if (result.exitCode !== 0) return [];
  return (result.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(AGENTBOX_PREFIX));
}

/**
 * Resolve the host port Docker assigned to a `-p hostPort:containerPort` mapping
 * that used `hostPort=0`. Returns null when the port isn't published or the
 * container is gone. `docker port <name> 6080/tcp` prints e.g.
 * `127.0.0.1:54321` (one line per binding); we take the first.
 */
export async function publishedHostPort(
  container: string,
  containerPort: number,
): Promise<number | null> {
  const result = await execa('docker', ['port', container, `${String(containerPort)}/tcp`], {
    reject: false,
  });
  if (result.exitCode !== 0) return null;
  const first = (result.stdout ?? '').split('\n')[0]?.trim();
  if (!first) return null;
  const m = /:(\d+)$/.exec(first);
  return m ? Number(m[1]) : null;
}

export async function listAgentboxVolumes(): Promise<string[]> {
  const result = await execa(
    'docker',
    ['volume', 'ls', '--filter', `name=^${AGENTBOX_PREFIX}`, '--format', '{{.Name}}'],
    { reject: false },
  );
  if (result.exitCode !== 0) return [];
  return (result.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(AGENTBOX_PREFIX));
}
