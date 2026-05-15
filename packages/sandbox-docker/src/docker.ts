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

export interface RunBoxSpec {
  name: string;
  image: string;
  lowerPath: string;
  upperVolume: string;
  nodeModulesVolume: string;
  extraVolumes?: string[];
  env?: Record<string, string>;
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
    '--device=/dev/fuse',
    '--security-opt=apparmor:unconfined',
    // Make the host reachable from inside the container at the well-known DNS
    // name host.docker.internal. Docker Desktop / OrbStack ship this alias by
    // default; on Linux native Docker it requires this explicit flag (no-op
    // on the macOS engines). Boxes use it to reach the host relay process.
    '--add-host=host.docker.internal:host-gateway',
    '-v',
    `${spec.lowerPath}:/host-src:ro`,
    '-v',
    `${spec.upperVolume}:/upper`,
    '-v',
    `${spec.nodeModulesVolume}:/workspace/node_modules`,
  ];
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

export async function execInBox(
  container: string,
  cmd: string[],
  opts: { user?: string; detach?: boolean } = {},
): Promise<DockerExecResult> {
  const args: string[] = ['exec'];
  if (opts.detach) args.push('-d');
  if (opts.user) args.push('--user', opts.user);
  args.push(container, ...cmd);
  const result = await execa('docker', args, { reject: false });
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
