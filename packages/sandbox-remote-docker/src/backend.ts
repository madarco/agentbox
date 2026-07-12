/**
 * `remoteDockerBackend` — a `CloudBackend` whose "sandbox" is a container on a
 * remote machine's Docker engine, reached over one SSH ControlMaster per box.
 *
 * It is a cloud backend, not a second docker provider, and that is the whole
 * design. The docker provider's core mechanism — bind-mounting the host's
 * `.git/` into the container so in-box commits land in the host repo with zero
 * sync — cannot cross a network. Everything that follows from that (the ctl
 * unix socket on a host path, `-p 127.0.0.1:…` on the *local* loopback,
 * `host.docker.internal` reaching the laptop's relay) is equally local-only.
 *
 * The cloud scaffold already solved all of it: `seedCloudWorkspace` syncs the
 * workspace as a shallow clone + carried-over stash/untracked, the in-box relay
 * on :8788 is long-polled by the host `CloudBoxPoller`, and `git push` travels
 * back as a bundle. So we implement the ~14 `CloudBackend` primitives in terms
 * of `docker` over SSH and inherit the rest.
 *
 * What stays docker-shaped: the image (a real Dockerfile build), checkpoints
 * (`docker commit`), nested containers (DinD, same caps as the local provider),
 * and pause (`docker pause`, a true freeze rather than a snapshot).
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  CloudBackend,
  CloudExecOptions,
  CloudExecResult,
  CloudFileEntry,
  CloudHandle,
  CloudPreviewUrl,
  CloudProvisionRequest,
  CloudSandboxSummary,
  CloudState,
} from '@agentbox/core';
import { loadEffectiveConfig } from '@agentbox/config';
import { CLOUD_VNC_PORT, CLOUD_WEB_PROXY_PORT, bashScript } from '@agentbox/sandbox-cloud';
import { readState, sshExec, type SshTargetArgs } from '@agentbox/sandbox-core';
import { ensureRemoteImage } from './image.js';
import {
  CONTAINER_USER,
  dockerExecArgv,
  dockerOnRemote,
  dockerOnRemoteOrThrow,
  ensureTunnel,
  pipeFileFromContainer,
  pipeFileIntoContainer,
  refreshTunnel,
  tunnels,
} from './remote-docker.js';
import {
  containerNameFor,
  makeSandboxId,
  parseRemoteTarget,
  parseSandboxId,
  type RemoteTarget,
} from './target.js';

export const BACKEND_NAME = 'remote-docker';

/**
 * A checkpoint is a `docker commit` on ONE engine — the image never leaves it —
 * so the snapshot name has to carry the host as well as the image ref:
 *
 *     "<ssh-destination>#<docker-image-ref>"
 *     e.g. "dev@10.0.0.9:2222#agentbox-ckpt-9f2a_myrepo:setup"
 *
 * `deleteSnapshot` and `snapshotExists` are handed nothing but this string (no
 * `CloudHandle`), so without the host they could not find the image at all. It
 * cannot go in the docker ref itself: a ref admits neither `@` nor `:` outside
 * the tag, and an ssh destination is full of both. `#` never appears in either
 * half, so it is an unambiguous separator.
 *
 * Nothing outside this package interprets the string — the `CloudBackend`
 * contract treats it as opaque, round-tripping it from `createSnapshot` through
 * the manifest to `provision({ snapshot })`.
 */
const SNAPSHOT_SEP = '#';

export interface ParsedSnapshot {
  host: string;
  imageRef: string;
}

export function makeSnapshotName(host: string, imageRef: string): string {
  return `${host}${SNAPSHOT_SEP}${imageRef}`;
}

export function parseSnapshotName(snapshotName: string): ParsedSnapshot {
  const sep = snapshotName.indexOf(SNAPSHOT_SEP);
  if (sep <= 0 || sep === snapshotName.length - 1) {
    throw new Error(
      `remote-docker: malformed snapshot name "${snapshotName}" — expected "<ssh-destination>#<image-ref>"`,
    );
  }
  return {
    host: snapshotName.slice(0, sep),
    imageRef: snapshotName.slice(sep + 1),
  };
}

/**
 * Tunnel id for a host-scoped (rather than box-scoped) connection — the image
 * ops, which act on an engine rather than a container.
 */
function snapshotTunnelId(host: string): string {
  return `engine:${host}`;
}

/** In-box relay port the host CloudBoxPoller long-polls (`/bridge/*`). */
const BRIDGE_PORT = 8788;
/** The box image's always-on sshd — published so `agentbox open` / `code` work. */
const SSH_PORT = 22;

/**
 * Ports published at `docker run`. Docker port mappings are immutable for the
 * life of a container (the same constraint Vercel has), so everything the host
 * may ever need to reach must be listed at create: the WebProxy, noVNC, the
 * bridge, sshd, plus whatever `agentbox.yaml` exposes.
 */
function portsToPublish(exposePorts: number[] | undefined): number[] {
  const base = [CLOUD_WEB_PROXY_PORT, CLOUD_VNC_PORT, BRIDGE_PORT, SSH_PORT];
  return [...new Set([...base, ...(exposePorts ?? [])])];
}

interface Ctx {
  target: SshTargetArgs;
  remote: RemoteTarget;
  container: string;
}

/**
 * Is the remote engine itself running inside an AgentBox sandbox? Only true in
 * the agentbox-in-agentbox dev loop this repo is developed with (CLAUDE.md ->
 * "Use Agentbox inside Agentbox"), where the nested dockerd lacks the
 * capabilities a normal engine has. `/etc/agentbox/box.env` is written into
 * every box by the create path, so its presence is the box's own identity file.
 */
async function remoteIsNested(target: SshTargetArgs): Promise<boolean> {
  const res = await sshExec(target, 'test -f /etc/agentbox/box.env');
  return res.exitCode === 0;
}

/** Resolve a handle into a live SSH connection + the container it names. */
async function ctxFor(h: CloudHandle): Promise<Ctx> {
  const { target: remote, container } = parseSandboxId(h.sandboxId);
  const target = await ensureTunnel(h.sandboxId, remote);
  return { target, remote, container };
}

/** `docker inspect` state string -> the provider-neutral CloudState. */
export function mapDockerState(status: string): CloudState {
  switch (status.trim()) {
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

/**
 * `docker port <c> <p>` -> the ephemeral port docker bound on the remote's
 * loopback. Its output is `127.0.0.1:49153` (possibly several lines, one per
 * binding); we take the first with a port.
 */
export function parseDockerPort(stdout: string): number | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /:(\d+)\s*$/.exec(line.trim());
    if (m?.[1]) {
      const port = Number.parseInt(m[1], 10);
      if (Number.isFinite(port) && port > 0) return port;
    }
  }
  return null;
}

/** Parse `--size` as `cpu-memory` GB (e2b's spec shape). */
export function parseSize(size: string | undefined): { cpu?: number; memory?: number } {
  if (!size) return {};
  const m = /^(\d+)(?:-(\d+))?$/.exec(size.trim());
  if (!m?.[1]) return {};
  const cpu = Number.parseInt(m[1], 10);
  const memory = m[2] ? Number.parseInt(m[2], 10) : undefined;
  return { cpu, ...(memory !== undefined ? { memory } : {}) };
}

/**
 * The `docker run` argv for a box. Mirrors the local provider's `runBox` flags
 * — the cap/security/cgroup set is what makes the in-box dockerd work, and the
 * two must not drift.
 */
export function buildRunArgv(opts: {
  container: string;
  image: string;
  env: Record<string, string>;
  ports: number[];
  dockerVolume: string;
  cpu?: number;
  memory?: number;
  /** The remote engine is itself inside an AgentBox sandbox — see `remoteIsNested`. */
  nestedEngine?: boolean;
}): string[] {
  const argv = [
    'run',
    '-d',
    '--name',
    opts.container,
    '--hostname',
    opts.container,
    // The in-box dockerd needs these: SYS_ADMIN to `mount -t overlay` for
    // overlay2, NET_ADMIN for its bridge + iptables NAT, /dev/fuse +
    // apparmor:unconfined for the fuse-overlayfs fallback, seccomp:unconfined
    // because the default profile blocks syscalls nested containers need, and a
    // private cgroup namespace so runc can create its own slice. Same set as
    // the local docker provider; we still avoid --privileged.
    '--cap-add=SYS_ADMIN',
    '--cap-add=NET_ADMIN',
    '--device=/dev/fuse',
    '--security-opt=apparmor:unconfined',
    '--security-opt=seccomp=unconfined',
    '--cgroupns=private',
  ];
  if (opts.nestedEngine) {
    // The engine is itself inside an AgentBox sandbox, which has no
    // CAP_SYS_PTRACE. Its dockerd therefore cannot bind-mount /proc/<pid>/ns/net
    // for a container whose init runs as a different uid than the daemon —
    // and the box image's default USER is vscode (1000), so `docker run` dies
    // with "bind-mount /proc/N/ns/net: permission denied". Forcing init to uid 0
    // makes its /proc readable by the daemon and netns setup succeeds.
    //
    // The local docker provider does the same thing (see `runBox`), but keys it
    // off ITS OWN `AGENTBOX=1`. Here that would be the wrong signal: the CLI can
    // run inside a box while the engine sits on a real machine that has no such
    // limitation. What matters is whether the ENGINE is nested, so we ask it.
    argv.push('--user', '0');
  }
  if (opts.cpu) argv.push('--cpus', String(opts.cpu));
  if (opts.memory) argv.push('--memory', `${String(opts.memory)}g`);
  // /var/lib/docker on a volume, not the container layer: without it, every
  // image the agent pulls inside the box would be captured by `docker commit`
  // and bloat each checkpoint.
  argv.push('-v', `${opts.dockerVolume}:/var/lib/docker`);
  for (const port of opts.ports) {
    // Bind the REMOTE's loopback only: the box is reached through the SSH
    // tunnel, so there is no reason to expose it on the remote's LAN.
    argv.push('-p', `127.0.0.1:0:${String(port)}`);
  }
  for (const [k, v] of Object.entries(opts.env)) {
    argv.push('-e', `${k}=${v}`);
  }
  argv.push(opts.image, 'sleep', 'infinity');
  return argv;
}

export const remoteDockerBackend: CloudBackend = {
  name: BACKEND_NAME,

  async provision(req: CloudProvisionRequest): Promise<CloudHandle> {
    const log = req.onLog ?? ((): void => {});
    // The SSH destination is resolved by the CLI (`docker:<host>` /
    // --remote-host / box.remoteDockerHost) and threaded through providerOptions.
    const spec = (req.host ?? '').trim();
    if (!spec) {
      throw new Error(
        'remote-docker: no SSH destination. Use `agentbox docker:<host> …`, `--remote-host <host>`, or set `box.remoteDockerHost`.',
      );
    }
    const remote = parseRemoteTarget(spec);
    const container = containerNameFor(req.name);
    const sandboxId = makeSandboxId(remote.spec, container);
    const target = await ensureTunnel(sandboxId, remote);

    // A checkpoint is a `docker commit`ed image on THIS engine; otherwise ensure
    // the fingerprint-tagged base image is present (pull, else build).
    let image: string;
    if (req.snapshot) {
      const snap = parseSnapshotName(req.snapshot);
      // A checkpoint cannot follow you to another machine: the image lives on
      // the engine that committed it. Read as "gone" rather than erroring, so
      // the scaffold prunes the dangling manifest and builds a fresh box.
      if (snap.host !== remote.spec) {
        throw new Error(
          `snapshot expired or deleted: it was captured on ${snap.host}, not ${remote.spec} (a remote-docker checkpoint is local to its engine)`,
        );
      }
      image = snap.imageRef;
      const probe = await dockerOnRemote(target, ['image', 'inspect', image]);
      if (probe.exitCode !== 0) {
        // Same contract as the other clouds: a vanished snapshot must read as
        // "gone" so the scaffold prunes the manifest and re-provisions from base.
        throw new Error(`snapshot expired or deleted: ${image} is not on ${remote.spec}`);
      }
    } else {
      const ensured = await ensureRemoteImage(target, {
        imageRef: req.image && req.image !== 'agentbox/box:dev' ? req.image : undefined,
        onLog: log,
      });
      image = ensured.ref;
    }

    const { cpu, memory } = parseSize(req.size);
    const dockerVolume = `agentbox-docker-${container}`;
    await dockerOnRemoteOrThrow(target, ['volume', 'create', dockerVolume]);

    const nestedEngine = await remoteIsNested(target);
    if (nestedEngine) {
      log('[provision] remote engine is itself an AgentBox box — running the box init as root');
    }

    const argv = buildRunArgv({
      container,
      image,
      env: req.env ?? {},
      ports: portsToPublish(req.exposePorts),
      dockerVolume,
      nestedEngine,
      ...(cpu !== undefined ? { cpu } : {}),
      ...(memory !== undefined ? { memory } : {}),
    });
    log(`[provision] docker run ${container} on ${remote.spec}`);
    await dockerOnRemoteOrThrow(target, argv, { timeoutMs: 300_000 });

    return {
      sandboxId,
      resources: {
        ...(cpu !== undefined ? { cpu } : {}),
        ...(memory !== undefined ? { memory } : {}),
      },
    };
  },

  async get(sandboxId: string): Promise<CloudHandle | null> {
    let ctx: Ctx;
    try {
      ctx = await ctxFor({ sandboxId });
    } catch {
      return null;
    }
    const res = await dockerOnRemote(ctx.target, [
      'inspect',
      '-f',
      '{{.State.Status}}',
      ctx.container,
    ]);
    return res.exitCode === 0 ? { sandboxId } : null;
  },

  /**
   * Every other cloud can ask its API "what sandboxes exist?". Here there is no
   * API and no registry of engines — a machine only becomes ours by being named
   * in a box record or in `box.remoteDockerHost`. So enumeration means: work out
   * which engines we have ever used, and ask each of them. An engine that has
   * gone away is skipped rather than fatal, since prune must still report on the
   * ones that answer.
   */
  async list(): Promise<CloudSandboxSummary[]> {
    const hosts = await knownHosts();
    const out: CloudSandboxSummary[] = [];
    for (const host of hosts) {
      try {
        out.push(...(await listOnHost(host)));
      } catch {
        // unreachable engine — nothing to report from it
      }
    }
    return out;
  },

  async start(h): Promise<void> {
    const ctx = await ctxFor(h);
    await dockerOnRemoteOrThrow(ctx.target, ['start', ctx.container], { timeoutMs: 120_000 });
  },

  async stop(h): Promise<void> {
    const ctx = await ctxFor(h);
    await dockerOnRemoteOrThrow(ctx.target, ['stop', ctx.container], { timeoutMs: 120_000 });
  },

  /**
   * A true freeze (SIGSTOP-equivalent via the freezer cgroup), not cold storage:
   * the container keeps its memory and its published ports, so resume is instant
   * and the forwarded ports stay valid.
   */
  async pause(h): Promise<void> {
    const ctx = await ctxFor(h);
    const state = await currentState(ctx);
    if (state !== 'running') return;
    await dockerOnRemoteOrThrow(ctx.target, ['pause', ctx.container]);
  },

  async resume(h): Promise<void> {
    const ctx = await ctxFor(h);
    const state = await currentState(ctx);
    if (state === 'paused') {
      await dockerOnRemoteOrThrow(ctx.target, ['unpause', ctx.container]);
      return;
    }
    if (state !== 'running') {
      await dockerOnRemoteOrThrow(ctx.target, ['start', ctx.container], { timeoutMs: 120_000 });
    }
  },

  async destroy(h): Promise<void> {
    const ctx = await ctxFor(h);
    // Idempotent: `rm -f` on a missing container is a no-op we tolerate, since
    // destroy must converge even after a partially-failed create.
    await dockerOnRemote(ctx.target, ['rm', '-f', ctx.container], { timeoutMs: 120_000 });
    await dockerOnRemote(ctx.target, ['volume', 'rm', '-f', `agentbox-docker-${ctx.container}`]);
    await tunnels.close(h.sandboxId);
  },

  async state(h): Promise<CloudState> {
    let ctx: Ctx;
    try {
      ctx = await ctxFor(h);
    } catch {
      // Unreachable host — the box may well be fine, but we cannot see it.
      return 'missing';
    }
    return currentState(ctx);
  },

  async exec(h, cmd: string, opts: CloudExecOptions = {}): Promise<CloudExecResult> {
    const ctx = await ctxFor(h);
    const argv = dockerExecArgv(ctx.container, cmd, {
      user: opts.user ?? CONTAINER_USER,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    });
    const res = await dockerOnRemote(ctx.target, argv, {
      timeoutMs: opts.attemptTimeoutMs ?? 300_000,
    });
    return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
  },

  async uploadFile(h, localPath: string, remotePath: string): Promise<void> {
    const ctx = await ctxFor(h);
    // The seed tars land in /tmp before an in-box extract; make sure the parent
    // exists, since `cat >` won't create it.
    await dockerOnRemote(
      ctx.target,
      dockerExecArgv(ctx.container, bashScript(`mkdir -p ${shellDir(remotePath)}`), {
        user: 'root',
      }),
    );
    await pipeFileIntoContainer(ctx.target, ctx.container, createReadStream(localPath), remotePath);
  },

  async downloadFile(h, remotePath: string, localPath: string): Promise<void> {
    const ctx = await ctxFor(h);
    await mkdir(dirname(localPath), { recursive: true });
    await pipeFileFromContainer(
      ctx.target,
      ctx.container,
      remotePath,
      createWriteStream(localPath),
    );
  },

  async listFiles(h, remoteDir: string): Promise<CloudFileEntry[]> {
    const ctx = await ctxFor(h);
    const res = await dockerOnRemote(
      ctx.target,
      dockerExecArgv(
        ctx.container,
        `find ${quote(remoteDir)} -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\n'`,
      ),
    );
    if (res.exitCode !== 0) return [];
    const out: CloudFileEntry[] = [];
    for (const line of res.stdout.split(/\r?\n/)) {
      const [name, kind] = line.split('\t');
      if (name) out.push({ name, isDir: kind === 'd' });
    }
    return out;
  },

  /**
   * The container's port is published on the REMOTE's loopback; we forward that
   * to a free local port over the box's ControlMaster. So the URL is always
   * `http://127.0.0.1:<local>` — reachable from the host browser and from the
   * host relay's poller alike.
   */
  async previewUrl(h, port: number): Promise<CloudPreviewUrl> {
    const ctx = await ctxFor(h);
    const remotePort = await publishedPort(ctx, port);
    const localPort = await tunnels.forward(h.sandboxId, remotePort);
    return { url: `http://127.0.0.1:${String(localPort)}` };
  },

  /** SSH is already the auth gate, so a "signed" URL is just the tunneled one. */
  async signedPreviewUrl(h, port: number): Promise<CloudPreviewUrl> {
    return remoteDockerBackend.previewUrl(h, port);
  },

  /**
   * The poller calls this when the local port stops answering — typically a
   * ControlMaster that died across a host sleep/wake. Re-open the master AND
   * re-read `docker port`: a container restart reassigns the remote's ephemeral
   * port, so a forward to the old one would connect to nothing.
   */
  async refreshPreviewUrl(h, port: number): Promise<CloudPreviewUrl> {
    const { target: remote } = parseSandboxId(h.sandboxId);
    await refreshTunnel(h.sandboxId, remote);
    return remoteDockerBackend.previewUrl(h, port);
  },

  async createSnapshot(h, snapshotName: string): Promise<void> {
    const ctx = await ctxFor(h);
    const snap = parseSnapshotName(snapshotName);
    await dockerOnRemoteOrThrow(ctx.target, ['commit', ctx.container, snap.imageRef], {
      timeoutMs: 600_000,
    });
  },

  async deleteSnapshot(snapshotName: string): Promise<void> {
    const snap = parseSnapshotName(snapshotName);
    try {
      const target = await ensureTunnel(snapshotTunnelId(snap.host), parseRemoteTarget(snap.host));
      await dockerOnRemote(target, ['image', 'rm', '-f', snap.imageRef]);
    } catch {
      // Unreachable host or already gone — best-effort, matching the other
      // clouds: the caller drops the local manifest either way.
    }
  },

  async snapshotExists(snapshotName: string): Promise<boolean> {
    let snap: ParsedSnapshot;
    try {
      snap = parseSnapshotName(snapshotName);
    } catch {
      return false;
    }
    try {
      const target = await ensureTunnel(snapshotTunnelId(snap.host), parseRemoteTarget(snap.host));
      const res = await dockerOnRemote(target, ['image', 'inspect', snap.imageRef]);
      return res.exitCode === 0;
    } catch {
      // Contract: must never throw. An unreachable engine reads as "not
      // bootable", which is the truth from here.
      return false;
    }
  },
};

/**
 * Engines this machine has used: every host named by a remote-docker box record,
 * plus the configured default. Deduped, order-stable.
 */
async function knownHosts(): Promise<string[]> {
  const hosts = new Set<string>();
  try {
    const state = await readState();
    for (const box of state.boxes) {
      if (box.provider !== BACKEND_NAME || !box.cloud?.sandboxId) continue;
      try {
        hosts.add(parseSandboxId(box.cloud.sandboxId).target.spec);
      } catch {
        // a malformed id names no engine we could ask
      }
    }
  } catch {
    // no state yet
  }
  try {
    const cfg = await loadEffectiveConfig(process.cwd());
    const dflt = (cfg.effective.box.remoteDockerHost || '').trim();
    if (dflt) hosts.add(dflt);
  } catch {
    // no config — the box records are all we have
  }
  return [...hosts];
}

/** List agentbox containers on one remote engine — the host-scoped `list()`. */
export async function listOnHost(spec: string): Promise<CloudSandboxSummary[]> {
  const remote = parseRemoteTarget(spec);
  const target = await ensureTunnel(`list:${remote.spec}`, remote);
  const res = await dockerOnRemote(target, [
    'ps',
    '-a',
    '--filter',
    'name=agentbox-',
    '--format',
    '{{.Names}}\t{{.State}}\t{{.CreatedAt}}',
  ]);
  if (res.exitCode !== 0) return [];
  const out: CloudSandboxSummary[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const [name, state, createdAt] = line.split('\t');
    if (!name) continue;
    out.push({
      sandboxId: makeSandboxId(remote.spec, name),
      name,
      ...(createdAt ? { createdAt } : {}),
      state: mapDockerState(state ?? ''),
    });
  }
  return out;
}

async function currentState(ctx: Ctx): Promise<CloudState> {
  const res = await dockerOnRemote(ctx.target, [
    'inspect',
    '-f',
    '{{.State.Status}}',
    ctx.container,
  ]);
  if (res.exitCode !== 0) return 'missing';
  return mapDockerState(res.stdout);
}

async function publishedPort(ctx: Ctx, containerPort: number): Promise<number> {
  const res = await dockerOnRemote(ctx.target, ['port', ctx.container, String(containerPort)]);
  const port = res.exitCode === 0 ? parseDockerPort(res.stdout) : null;
  if (port === null) {
    throw new Error(
      `remote-docker: container port ${String(containerPort)} is not published on ${ctx.container}. ` +
        'Docker port mappings are fixed at create — a service exposed after the box was made is only ' +
        'reachable through the :80 WebProxy until the box is recreated.',
    );
  }
  return port;
}

function shellDir(path: string): string {
  const slash = path.lastIndexOf('/');
  return quote(slash > 0 ? path.slice(0, slash) : '/');
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
