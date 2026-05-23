/**
 * Daytona `CloudBackend` — maps the provider-neutral cloud primitives onto
 * `@daytonaio/sdk`. Lazy SDK client + lazy sandbox handle resolution so
 * importing this module costs nothing until a daytona-tagged box does something.
 */

import { Daytona, Image, SandboxState, type Sandbox } from '@daytonaio/sdk';
import type {
  CloudBackend,
  CloudExecOptions,
  CloudExecResult,
  CloudFileEntry,
  CloudHandle,
  CloudPreviewUrl,
  CloudProvisionRequest,
  CloudState,
  CloudVolumeMount,
} from '@agentbox/core';
import { resolveDockerfileContext } from './dockerfile-context.js';
import { ensureDaytonaEnvLoaded } from './env-loader.js';
import { withDaytonaRetry } from './retry.js';

/**
 * Thin shorthand for `withDaytonaRetry` with our defaults. Most methods are
 * idempotent and use `retryOnAmbiguous: true`; the few that aren't override.
 */
function retry<T>(
  method: string,
  fn: () => Promise<T>,
  opts: { attemptTimeoutMs?: number; retryOnAmbiguous?: boolean } = {},
): Promise<T> {
  return withDaytonaRetry(
    {
      method,
      retryOnAmbiguous: opts.retryOnAmbiguous ?? true,
      attemptTimeoutMs: opts.attemptTimeoutMs,
    },
    fn,
  );
}

/**
 * Sentinel image ref the cloud-provider hands to us when the user didn't pass
 * `--image`. We translate it to `Image.fromDockerfile(...)` so Daytona builds
 * the same box image the Docker provider builds locally.
 */
export const DEFAULT_BOX_IMAGE_REF = 'agentbox/box:dev';

let client: Daytona | null = null;
function getClient(): Daytona {
  if (!client) {
    // Pull DAYTONA_* keys from `.env.local` / `.env` / `~/.agentbox/secrets.env`
    // into process.env first — the SDK reads from process.env and most users
    // keep secrets in a project file rather than their shell rc.
    ensureDaytonaEnvLoaded();
    try {
      // Daytona() reads DAYTONA_API_KEY / DAYTONA_JWT_TOKEN + DAYTONA_ORGANIZATION_ID
      // from env.
      client = new Daytona();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The interactive prompt in `agentbox daytona login` handles first-run
      // setup; this error path is for non-TTY callers (CI, scripts) where the
      // prompt was skipped.
      throw new Error(
        `Daytona credentials not configured: ${msg}\n` +
          `Run \`agentbox daytona login\` interactively, or set DAYTONA_API_KEY in the environment.`,
      );
    }
  }
  return client;
}

async function getSandbox(id: string): Promise<Sandbox> {
  return getClient().get(id);
}

async function maybeGetSandbox(id: string): Promise<Sandbox | null> {
  try {
    return await getClient().get(id);
  } catch {
    return null;
  }
}

/**
 * Map Daytona's `SandboxState` (16 fine-grained values incl. transitional ones)
 * onto our 4-value `CloudState`. Transitional states ('starting', 'creating')
 * are reported as 'running' so callers don't ping-pong; 'archived' maps to
 * 'paused' (our pause is Daytona's archive).
 */
function mapState(s: SandboxState | string | undefined): CloudState {
  switch (s) {
    case SandboxState.STARTED:
      return 'running';
    case SandboxState.STARTING:
    case SandboxState.CREATING:
    case SandboxState.RESTORING:
    case SandboxState.BUILDING_SNAPSHOT:
    case SandboxState.PULLING_SNAPSHOT:
    case SandboxState.PENDING_BUILD:
    case SandboxState.STOPPING:
      return 'running';
    case SandboxState.STOPPED:
      return 'stopped';
    case SandboxState.ARCHIVED:
    case SandboxState.ARCHIVING:
      return 'paused';
    case SandboxState.DESTROYED:
    case SandboxState.DESTROYING:
    case SandboxState.ERROR:
    case SandboxState.BUILD_FAILED:
    case SandboxState.UNKNOWN:
    default:
      return 'missing';
  }
}

/**
 * Translate our provider-neutral `CloudVolumeMount` into the SDK shape Daytona
 * expects. The SDK's `VolumeMount` carries `volumeId` + `mountPath` (+ optional
 * `subpath` for S3-prefix mounts); a 1:1 mapping with our type.
 */
function toDaytonaVolumeMount(v: CloudVolumeMount): {
  volumeId: string;
  mountPath: string;
  subpath?: string;
} {
  return {
    volumeId: v.volumeId,
    mountPath: v.mountPath,
    ...(v.subpath ? { subpath: v.subpath } : {}),
  };
}

/** Translate the request's image ref into something Daytona's `create` accepts. */
function resolveImage(ref: string): string | Image {
  if (ref !== DEFAULT_BOX_IMAGE_REF) return ref;
  const ctx = resolveDockerfileContext();
  if (!ctx) {
    throw new Error(
      "could not locate the AgentBox Dockerfile.box build context for the Daytona snapshot. " +
        "Set AGENTBOX_DOCKER_CONTEXT to a directory containing Dockerfile.box, or pass --image <ref> with a Daytona-compatible image.",
    );
  }
  // Image.fromDockerfile bundles the directory the Dockerfile lives in and
  // ships it to Daytona to build a snapshot. The Dockerfile.box COPYs from
  // the monorepo tree; the staged `runtime/docker` context already mirrors
  // that tree, so the build resolves COPY paths correctly.
  return Image.fromDockerfile(ctx.dockerfile);
}

export const daytonaBackend: CloudBackend = {
  name: 'daytona',

  async provision(req: CloudProvisionRequest): Promise<CloudHandle> {
    // No-retry: provision is non-idempotent — a 504 after the request reaches
    // the origin could create a duplicate billable sandbox we can't reference
    // for cleanup. The wrapper still bounds wall-clock at 900s (matching the
    // existing inline SDK timeout) so a wedged connection fails cleanly.
    return retry(
      'provision',
      async () => {
        const image = resolveImage(req.image);
        // The first-time Dockerfile.box snapshot build is ~41 layers and pulls
        // Chromium — comfortably 5+ minutes wall time. Daytona's default ready
        // timeout is too short for that; override with 15 min so a cold build
        // doesn't fail mid-snapshot. Cached snapshots come up in seconds.
        const sandbox = await getClient().create(
          {
            image,
            ...(req.resources ? { resources: req.resources } : {}),
            envVars: req.env,
            ...(req.volumes && req.volumes.length > 0
              ? { volumes: req.volumes.map(toDaytonaVolumeMount) }
              : {}),
            labels: { 'agentbox.name': req.name },
          },
          {
            timeout: 900,
            ...(req.onLog ? { onSnapshotCreateLogs: req.onLog } : {}),
          },
        );
        return { sandboxId: sandbox.id };
      },
      { retryOnAmbiguous: false, attemptTimeoutMs: 900_000 },
    );
  },

  async ensureVolume(name: string): Promise<{ volumeId: string }> {
    // Daytona's `volume.get(name, create=true)` returns the existing volume or
    // initiates creation on first call. Critically, a freshly-created volume
    // comes back in `creating`/`pending_create` state — passing such a volume
    // into `Daytona.create({ volumes: […] })` is rejected with
    // "Volume is not in a ready state. Current state: creating". So poll
    // `volume.get` until the state lands on `ready` (or a terminal failure).
    //
    // Volumes are org-scoped on Daytona — every sandbox in the same Daytona
    // organization sees the same id, which is what we want for sharing agent
    // credentials across all of a user's boxes.
    //
    // Each individual `volume.get` call is retry-wrapped so a transient edge
    // hiccup mid-poll doesn't fail the whole ensure.
    const client = getClient();
    let vol = await retry('volume.get(create)', () => client.volume.get(name, true));
    // Volumes typically transition from creating → ready within a few seconds.
    // Allow up to 60s in case of slow control-plane operations.
    const deadline = Date.now() + 60_000;
    while (vol.state !== 'ready') {
      if (vol.state === 'error' || vol.state === 'deleted' || vol.state === 'deleting') {
        throw new Error(
          `Daytona volume '${name}' is in unrecoverable state '${vol.state}'. ` +
            `Delete it from the Daytona dashboard and retry.`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Daytona volume '${name}' did not become ready within 60s (state: ${vol.state}). ` +
            `Try again — the Daytona control plane may be slow.`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
      vol = await retry('volume.get(poll)', () => client.volume.get(name));
    }
    return { volumeId: vol.id };
  },

  async get(sandboxId: string): Promise<CloudHandle | null> {
    return retry('get', async () => {
      const sb = await maybeGetSandbox(sandboxId);
      return sb ? { sandboxId: sb.id } : null;
    });
  },

  async start(h: CloudHandle): Promise<void> {
    return retry(
      'start',
      async () => {
        const sb = await getSandbox(h.sandboxId);
        await sb.start();
      },
      { attemptTimeoutMs: 60_000 },
    );
  },

  async stop(h: CloudHandle): Promise<void> {
    return retry(
      'stop',
      async () => {
        const sb = await getSandbox(h.sandboxId);
        await sb.stop();
      },
      { attemptTimeoutMs: 60_000 },
    );
  },

  async pause(h: CloudHandle): Promise<void> {
    // Our pause == cold storage (Daytona archive). The tradeoff is documented
    // in CloudBackend's interface comment.
    return retry(
      'pause',
      async () => {
        const sb = await getSandbox(h.sandboxId);
        await sb.archive();
      },
      { attemptTimeoutMs: 60_000 },
    );
  },

  async resume(h: CloudHandle): Promise<void> {
    return retry(
      'resume',
      async () => {
        const sb = await getSandbox(h.sandboxId);
        await sb.start();
      },
      { attemptTimeoutMs: 60_000 },
    );
  },

  async destroy(h: CloudHandle): Promise<void> {
    return retry(
      'destroy',
      async () => {
        const sb = await maybeGetSandbox(h.sandboxId);
        if (!sb) return; // already gone — destroy is idempotent
        // Daytona's `delete()` on a running sandbox is queued, not synchronous —
        // observed in practice: `delete()` returns ok, the sandbox stays in
        // 'started' for tens of seconds, then eventually disappears. Stopping
        // first makes the delete synchronous so callers (and the dashboard) see
        // it gone immediately. Swallow stop errors — if the sandbox is already
        // stopped/archived, delete still works.
        try {
          await sb.stop(60);
        } catch {
          /* best-effort */
        }
        try {
          await sb.delete(60);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Already deleted between stop and delete — fine.
          if (!/not found/i.test(msg)) throw err;
        }
      },
      { attemptTimeoutMs: 120_000 },
    );
  },

  async state(h: CloudHandle): Promise<CloudState> {
    return retry('state', async () => {
      const sb = await maybeGetSandbox(h.sandboxId);
      if (!sb) return 'missing';
      return mapState(sb.state);
    });
  },

  async exec(
    h: CloudHandle,
    cmd: string,
    opts?: CloudExecOptions,
  ): Promise<CloudExecResult> {
    return retry(
      'exec',
      async () => {
        const sb = await getSandbox(h.sandboxId);
        // Daytona's ExecuteResponse returns combined output in `result` with no
        // separate stderr stream. Surface it as stdout and leave stderr empty —
        // callers that need split streams must redirect inside `cmd` itself.
        const r = await sb.process.executeCommand(cmd, opts?.cwd, opts?.env);
        return { exitCode: r.exitCode, stdout: r.result, stderr: '' };
      },
      { attemptTimeoutMs: 120_000 },
    );
  },

  async uploadFile(h: CloudHandle, localPath: string, remotePath: string): Promise<void> {
    return retry(
      'uploadFile',
      async () => {
        const sb = await getSandbox(h.sandboxId);
        await sb.fs.uploadFile(localPath, remotePath);
      },
      { attemptTimeoutMs: 300_000 },
    );
  },

  async downloadFile(h: CloudHandle, remotePath: string, localPath: string): Promise<void> {
    return retry(
      'downloadFile',
      async () => {
        const sb = await getSandbox(h.sandboxId);
        await sb.fs.downloadFile(remotePath, localPath);
      },
      { attemptTimeoutMs: 300_000 },
    );
  },

  async listFiles(h: CloudHandle, remoteDir: string): Promise<CloudFileEntry[]> {
    return retry('listFiles', async () => {
      const sb = await getSandbox(h.sandboxId);
      const files = await sb.fs.listFiles(remoteDir);
      return files.map((f) => ({
        name: f.name,
        isDir: Boolean((f as { isDir?: boolean }).isDir),
      }));
    });
  },

  async previewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    return retry('previewUrl', async () => {
      const sb = await getSandbox(h.sandboxId);
      const p = await sb.getPreviewLink(port);
      // The host CloudBoxPoller attaches `token` as `x-daytona-preview-token`
      // for every /bridge call. Browser-bound URLs use `signedPreviewUrl` below
      // instead (the two token kinds are not interchangeable on Daytona).
      return { url: p.url, token: p.token };
    });
  },

  async signedPreviewUrl(
    h: CloudHandle,
    port: number,
    expiresInSeconds: number,
  ): Promise<CloudPreviewUrl> {
    return retry('signedPreviewUrl', async () => {
      const sb = await getSandbox(h.sandboxId);
      const s = await sb.getSignedPreviewUrl(port, expiresInSeconds);
      return { url: s.url, token: s.token };
    });
  },

  async attachArgv(h: CloudHandle): Promise<string[]> {
    return retry('attachArgv', async () => {
      const sb = await getSandbox(h.sandboxId);
      // 60 min default expiry matches the SDK default; an interactive session
      // longer than that is rare. `sandbox-cloud`'s buildAttach appends
      // `-t '<inner cmd>'` for the per-session tmux attach.
      const ssh = await sb.createSshAccess(60);
      return [
        'ssh',
        // First-connect to a never-seen host fingerprint should be silent in a
        // PTY — the user already authenticated via Daytona's API.
        '-o', 'StrictHostKeyChecking=accept-new',
        // Daytona's SSH gateway terminates per-token; no key file, no port.
        `${ssh.token}@ssh.app.daytona.io`,
      ];
    });
  },

  async revokeAttachToken(h: CloudHandle, argv: string[]): Promise<void> {
    // argv[3] = `${token}@ssh.app.daytona.io`; pull the token off the front.
    const userhost = argv[argv.length - 1] ?? '';
    const atIdx = userhost.indexOf('@');
    if (atIdx <= 0) return;
    const token = userhost.slice(0, atIdx);
    if (token.length === 0) return;
    try {
      await retry('revokeAttachToken', async () => {
        const sb = await getSandbox(h.sandboxId);
        await sb.revokeSshAccess(token);
      });
    } catch {
      // Best-effort — tokens auto-expire after 60 min anyway.
    }
  },
};
