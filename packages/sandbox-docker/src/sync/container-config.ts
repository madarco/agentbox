import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { streamTarPipe } from '../box-cp.js';
import { CONTAINER_USER } from './agents/shared.js';

export interface ContainerConfigOptions {
  container: string;
  image: string;
  /** The registry's config root, including relocated subpaths for this agent. */
  configDir: string;
}

/** Resolve actual mounts from inspectBox; recorded/shared volumes may be absent. */
export function resolveContainerConfigVolume(
  dockerInspect: unknown,
  configDir: string,
): string | undefined {
  const mounts = (
    dockerInspect as {
      Mounts?: { Type: string; Name?: string; Destination: string; RW: boolean }[];
    } | null
  )?.Mounts;
  if (!Array.isArray(mounts)) throw new Error('could not inspect container config mounts');
  const mount = mounts.find((item) => item.Destination === configDir);
  if (mount?.RW === false) throw new Error(`agent config is read-only: ${configDir}`);
  return mount?.Type === 'volume' ? mount.Name : undefined;
}

async function copyConfig(source: string[], destination: string[]): Promise<void> {
  const results = await streamTarPipe('docker', source, 'docker', destination);
  for (const result of results) {
    if (result.exitCode !== 0) {
      const stderr =
        typeof result.stderr === 'string'
          ? result.stderr
          : Buffer.from(result.stderr ?? []).toString('utf8');
      throw new Error(`container config copy failed: ${stderr.slice(0, 300)}`);
    }
  }
}

/**
 * Run the existing agent-specific volume sync against a config directory in
 * the container's writable layer. Docker cannot add a mount to a live box.
 * Seed the temporary volume from the box first, so the usual merge keeps
 * box-owned plugins, MCP servers and other state. Copy back only after the
 * sync succeeds; do not persist this temporary volume in the box record.
 * The caller must first ensure the agent has no running session.
 */
export async function withContainerConfigVolume<T>(
  opts: ContainerConfigOptions,
  sync: (volume: string) => Promise<T>,
): Promise<T> {
  const volume = `agentbox-config-sync-${randomUUID()}`;
  const boxExec = ['exec', '--user', '0', opts.container];
  const volumeRun = ['run', '--rm', '--user', '0', '-v', `${volume}:/dst`];
  let volumeCreated = false;
  let boxStage: string | undefined;
  let result: T | undefined;
  const errors: unknown[] = [];

  try {
    await execa('docker', [
      'exec',
      '--user',
      CONTAINER_USER,
      opts.container,
      'mkdir',
      '-p',
      opts.configDir,
    ]);
    await execa('docker', ['volume', 'create', volume]);
    volumeCreated = true;
    await copyConfig(
      [...boxExec, 'tar', '-C', opts.configDir, '-cf', '-', '.'],
      [...volumeRun, '-i', opts.image, 'tar', '-xf', '-', '-C', '/dst'],
    );
    result = await sync(volume);

    const allocated = await execa('docker', [
      ...boxExec,
      'mktemp',
      '-d',
      '/tmp/agentbox-config-XXXXXXXX',
    ]);
    boxStage = allocated.stdout.trim();
    if (!/^\/tmp\/agentbox-config-[A-Za-z0-9]+$/.test(boxStage)) {
      boxStage = undefined;
      throw new Error('could not allocate the in-box config staging directory');
    }
    await copyConfig(
      [...volumeRun, opts.image, 'tar', '-C', '/dst', '-cf', '-', '.'],
      ['exec', '-i', '--user', '0', opts.container, 'tar', '-xf', '-', '-C', boxStage],
    );
    await execa('docker', [
      ...boxExec,
      'sh',
      '-c',
      // Both sides start with the box's original tree. Mirror the prepared
      // result so agent-specific purges are reflected, as on a mounted volume.
      'rsync -a --delete -- "$1/" "$2/" && chown -R "$3:$3" "$2"',
      'sh',
      boxStage,
      opts.configDir,
      CONTAINER_USER,
    ]);
  } catch (error) {
    errors.push(error);
  } finally {
    // Keep both the original failure and any failure to remove credential copies.
    const cleanup = await Promise.allSettled([
      ...(volumeCreated ? [execa('docker', ['volume', 'rm', volume])] : []),
      ...(boxStage ? [execa('docker', [...boxExec, 'rm', '-rf', '--', boxStage])] : []),
    ]);
    for (const item of cleanup) if (item.status === 'rejected') errors.push(item.reason);
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, 'container config sync or cleanup failed');
  return result as T;
}
