/**
 * The `linux-vm` half of `agentbox prepare --provider daytona`.
 *
 * The container path builds its base with Daytona's declarative builder
 * (`Image.fromDockerfile` + layered seed commands). **That is not available for
 * VMs** — Daytona builds a VM snapshot only from a prebuilt registry image
 * (verified 2026-07-12: passing an `Image` with `sandboxClass: LINUX_VM` fails
 * with `build snapshot: rpc error: code = Unauthenticated`). So the VM bake is
 * shaped like Hetzner's and Vercel's instead — boot once, provision in-place,
 * snapshot the result:
 *
 *   1. `snapshot.create` a VM snapshot straight from the published GHCR box
 *      image (`ghcr.io/madarco/agentbox/box:sha-<docker-context-sha>`), which
 *      CI already builds and publishes. ~66s, vs ~7 min for a Dockerfile build.
 *   2. Boot one throwaway sandbox from it and, in-place:
 *        a. repair `sudo` (see below),
 *        b. seed the host's agent static config + the daytona CLAUDE.md overlay.
 *   3. Stop it and cold-snapshot it as the real base, then delete it.
 *
 * ## Why sudo needs repairing
 *
 * Converting the container image into a VM rootfs strips setuid bits: `sudo`
 * lands as mode 0755 and cannot escalate ("must be owned by uid 0 and have the
 * setuid bit set"). Only mount/umount/su keep theirs. That breaks the seed
 * (installing `/etc/claude-code/CLAUDE.md` needs root) and breaks the
 * passwordless sudo the in-box agent is told it has. `create({ user: 'root' })`
 * is not a way out — the sandbox then fails to start.
 *
 * The escape hatch is the docker socket, which the image already gives us:
 * dockerd runs at boot and `vscode` is in the `docker` group, so a privileged
 * container can write the host VM's filesystem. The repair persists into the
 * snapshot, so every box booted from this base has working sudo from the start.
 */
import type { CloudBackend, CloudHandle } from '@agentbox/core';
import type { Daytona } from '@daytona/sdk';
import { SandboxClass } from '@daytona/sdk';
import { seedAgentStaticIntoCloudBox } from '@agentbox/sandbox-cloud';
import { BOX_IMAGE_REGISTRY, registryRefForSha } from '@agentbox/sandbox-core';

/**
 * Restore sudo's setuid bit (and quiet its hostname warning) from inside the
 * box, by borrowing root from the docker daemon. Exported for the unit test.
 *
 * `--privileged -v /:/host` is what lets an unprivileged `vscode` write a
 * root-owned file: the container runs as root and sees the VM's rootfs at
 * /host. This is not a privilege escalation we are introducing — `vscode` is
 * already in the `docker` group, which is root-equivalent by construction.
 */
export function buildSudoRepairCommand(): string {
  return (
    'docker run --rm --privileged -v /:/host alpine sh -c ' +
    `'chown root:root /host/usr/bin/sudo && chmod 4755 /host/usr/bin/sudo && ` +
    // sudo emits "unable to resolve host <name>" on every call when the box's
    // hostname has no /etc/hosts entry. Noisy, and it costs a DNS timeout.
    `grep -q "\\b$(cat /host/etc/hostname)\\b" /host/etc/hosts || ` +
    `echo "127.0.0.1 $(cat /host/etc/hostname)" >> /host/etc/hosts'`
  );
}

/** Poll until dockerd answers — it starts at boot, but not instantly. */
export function buildDockerWaitCommand(): string {
  return 'for i in $(seq 1 30); do docker info >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1';
}

export interface VmBaseBakeOptions {
  client: Daytona;
  backend: CloudBackend;
  /** Region the VM snapshot is registered in — only us-east-1 has VM runners. */
  regionId: string;
  /** Final base-snapshot name, pinned into `box.imageDaytona`. */
  snapshotName: string;
  /** Raw docker build-context sha — names the published GHCR image. */
  dockerBaseSha: string;
  /** Registry override (`box.imageRegistry`); empty = the public default. */
  registry?: string;
  resources?: { cpu: number; memory: number; disk: number };
  hostWorkspace?: string;
  /** Host path to the daytona `/etc/claude-code/CLAUDE.md` overlay. */
  claudeMdOverlay: string;
  onLog?: (line: string) => void;
}

/**
 * Thrown when the GHCR image the VM base must boot from doesn't exist for this
 * build context — a locally edited `Dockerfile.box`, or an npm Claude install
 * (CI publishes only the native variant). The caller degrades to the container
 * class rather than dead-ending the user.
 */
export class VmBaseImageUnavailableError extends Error {}

/** Does the registry actually have this tag? Anonymous HEAD — no docker needed. */
export async function ghcrTagExists(ref: string): Promise<boolean> {
  // ghcr.io/<owner>/<path>:<tag>
  const m = /^ghcr\.io\/(.+):([^:]+)$/.exec(ref);
  if (!m) return true; // non-GHCR registry: don't pretend to know; let the bake try.
  const [, repo, tag] = m;
  try {
    const tokenRes = await fetch(
      `https://ghcr.io/token?scope=repository:${repo}:pull&service=ghcr.io`,
    );
    if (!tokenRes.ok) return false;
    const { token } = (await tokenRes.json()) as { token?: string };
    if (!token) return false;
    const res = await fetch(`https://ghcr.io/v2/${repo}/manifests/${tag}`, {
      method: 'HEAD',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: [
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
          'application/vnd.docker.distribution.manifest.v2+json',
        ].join(','),
      },
    });
    return res.ok;
  } catch {
    // Network trouble is not "the tag is missing" — let the bake surface the
    // real error rather than silently downgrading the user to a container.
    return true;
  }
}

/**
 * Bake the linux-vm base snapshot. Returns the final snapshot's name.
 */
export async function bakeDaytonaVmBase(opts: VmBaseBakeOptions): Promise<string> {
  const log = opts.onLog ?? (() => {});
  const registry = opts.registry && opts.registry.length > 0 ? opts.registry : BOX_IMAGE_REGISTRY;
  const imageRef = registryRefForSha(opts.dockerBaseSha, registry);

  if (!(await ghcrTagExists(imageRef))) {
    throw new VmBaseImageUnavailableError(
      `the linux-vm base needs a published box image, and '${imageRef}' isn't in the registry.`,
    );
  }

  // Tier 1: the plain box image as a VM snapshot. Content-addressed by the
  // docker sha, so re-baking a different agent config reuses it.
  const vmBaseName = `agentbox-vmbase-${opts.dockerBaseSha.slice(0, 12)}`;
  const existing = await snapshotIfActive(opts.client, vmBaseName);
  if (existing) {
    log(`reusing linux-vm base image snapshot '${vmBaseName}'`);
  } else {
    log(`creating linux-vm base image snapshot '${vmBaseName}' from ${imageRef}…`);
    await opts.client.snapshot.create(
      {
        name: vmBaseName,
        image: imageRef,
        sandboxClass: SandboxClass.LINUX_VM,
        regionId: opts.regionId,
        ...(opts.resources ? { resources: opts.resources } : {}),
      },
      { onLogs: (c: string) => log(String(c).split('\n').filter(Boolean).join(' ')) },
    );
  }

  // Tier 2: boot it, provision in-place, snapshot the result.
  log('booting a throwaway sandbox to seed the base…');
  const sandbox = await opts.client.create({ snapshot: vmBaseName }, { timeout: 900 });
  const handle: CloudHandle = { sandboxId: sandbox.id, sandboxClass: 'linux-vm' };
  try {
    const wait = await opts.backend.exec(handle, buildDockerWaitCommand());
    if (wait.exitCode !== 0) {
      throw new Error(
        'dockerd never came up in the VM base, so sudo cannot be repaired ' +
          '(the repair borrows root from the docker socket).',
      );
    }
    log('repairing sudo (the VM rootfs conversion strips setuid bits)…');
    const repair = await opts.backend.exec(handle, buildSudoRepairCommand());
    if (repair.exitCode !== 0) {
      throw new Error(
        `failed to restore sudo in the VM base (exit ${String(repair.exitCode)}): ` +
          `${repair.stdout}${repair.stderr}`,
      );
    }

    await seedAgentStaticIntoCloudBox(opts.backend, handle, {
      hostWorkspace: opts.hostWorkspace,
      claudeMdOverlay: opts.claudeMdOverlay,
      onLog: log,
    });

    // Cold snapshot: filesystem only, and Daytona requires the sandbox STOPPED.
    // It does not stop for you.
    log('stopping the sandbox to capture a cold snapshot…');
    await sandbox.stop();
    log(`capturing base snapshot '${opts.snapshotName}'…`);
    await sandbox._experimental_createSnapshot(opts.snapshotName, 900);
    await waitForSnapshotActive(opts.client, opts.snapshotName);
    log(`snapshot '${opts.snapshotName}' is active`);
    return opts.snapshotName;
  } finally {
    // Always reap the throwaway — an orphan VM bills by the hour.
    try {
      await sandbox.delete(120);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`warning: could not delete the temporary bake sandbox ${sandbox.id}: ${msg}`);
    }
  }
}

async function snapshotIfActive(client: Daytona, name: string): Promise<boolean> {
  try {
    const snap = await client.snapshot.get(name);
    return snap?.state === 'active';
  } catch {
    return false;
  }
}

/**
 * `_experimental_createSnapshot` returns once the capture is requested; the
 * snapshot reaches `active` shortly after. Deleting the source sandbox before
 * then is untested, so wait.
 */
async function waitForSnapshotActive(client: Daytona, name: string): Promise<void> {
  const deadline = Date.now() + 900_000;
  for (;;) {
    let state: string | undefined;
    try {
      state = (await client.snapshot.get(name))?.state;
    } catch {
      state = undefined;
    }
    if (state === 'active') return;
    if (state === 'error' || state === 'build_failed') {
      throw new Error(`daytona snapshot '${name}' ended in state '${state}'`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `daytona snapshot '${name}' did not become active within 15 min (state: ${state ?? 'unknown'})`,
      );
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
