import { execInBox } from './docker.js';

export interface DockerdLaunchResult {
  up: boolean;
  reason?: string;
}

/**
 * Shared image-cache volume across boxes. When a box is created with
 * `dockerCacheShared=true`, its in-box dockerd's data root is this volume
 * instead of the per-box `agentbox-docker-<id>` volume. Mutually exclusive at
 * runtime: only one box can hold the lock on `/var/lib/docker` at a time —
 * dockerd's own boltdb lock will refuse a second start. This is a power-user
 * feature for users who run boxes serially and want pulled layers to persist
 * across recreations; documented as such on the CLI flag.
 */
export const SHARED_DOCKER_CACHE_VOLUME = 'agentbox-docker-cache';

export function dockerVolumeName(boxId: string, shared: boolean): string {
  return shared ? SHARED_DOCKER_CACHE_VOLUME : `agentbox-docker-${boxId}`;
}

/**
 * Spawn the in-container dockerd via `/usr/local/bin/agentbox-dockerd-start`
 * detached, then poll for `/var/run/docker.sock` to become accept()-able.
 * Best-effort, mirroring {@link launchVncDaemon} — failure is logged but
 * doesn't fail box creation. Default timeout 30s: first start has to
 * initialize iptables + the storage graphdriver, which is slower than the
 * VNC stack.
 */
export async function launchDockerdDaemon(
  container: string,
  timeoutMs = 30_000,
): Promise<DockerdLaunchResult> {
  const result = await execInBox(container, ['/usr/local/bin/agentbox-dockerd-start'], {
    user: 'root',
    detach: true,
  });
  if (result.exitCode !== 0) {
    return { up: false, reason: `docker exec failed: ${result.stderr || result.stdout}` };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await execInBox(
      container,
      [
        'bash',
        '-lc',
        '[ -S /var/run/docker.sock ] && docker -H unix:///var/run/docker.sock info >/dev/null 2>&1',
      ],
      { user: 'root' },
    );
    if (probe.exitCode === 0) return { up: true };
    await new Promise((r) => setTimeout(r, 200));
  }
  return { up: false, reason: `dockerd did not become ready within ${String(timeoutMs)}ms` };
}
