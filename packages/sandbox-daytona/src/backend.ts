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
} from '@agentbox/core';
import { resolveDockerfileContext } from './dockerfile-context.js';

/**
 * Sentinel image ref the cloud-provider hands to us when the user didn't pass
 * `--image`. We translate it to `Image.fromDockerfile(...)` so Daytona builds
 * the same box image the Docker provider builds locally.
 */
export const DEFAULT_BOX_IMAGE_REF = 'agentbox/box:dev';

let client: Daytona | null = null;
function getClient(): Daytona {
  if (!client) {
    // Daytona() reads DAYTONA_API_KEY from env. Throws with a clear error if
    // missing — the CLI surfaces that.
    client = new Daytona();
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
        labels: { 'agentbox.name': req.name },
      },
      {
        timeout: 900,
        ...(req.onLog ? { onSnapshotCreateLogs: req.onLog } : {}),
      },
    );
    return { sandboxId: sandbox.id };
  },

  async get(sandboxId: string): Promise<CloudHandle | null> {
    const sb = await maybeGetSandbox(sandboxId);
    return sb ? { sandboxId: sb.id } : null;
  },

  async start(h: CloudHandle): Promise<void> {
    const sb = await getSandbox(h.sandboxId);
    await sb.start();
  },

  async stop(h: CloudHandle): Promise<void> {
    const sb = await getSandbox(h.sandboxId);
    await sb.stop();
  },

  async pause(h: CloudHandle): Promise<void> {
    // Our pause == cold storage (Daytona archive). The tradeoff is documented
    // in CloudBackend's interface comment.
    const sb = await getSandbox(h.sandboxId);
    await sb.archive();
  },

  async resume(h: CloudHandle): Promise<void> {
    const sb = await getSandbox(h.sandboxId);
    await sb.start();
  },

  async destroy(h: CloudHandle): Promise<void> {
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

  async state(h: CloudHandle): Promise<CloudState> {
    const sb = await maybeGetSandbox(h.sandboxId);
    if (!sb) return 'missing';
    return mapState(sb.state);
  },

  async exec(
    h: CloudHandle,
    cmd: string,
    opts?: CloudExecOptions,
  ): Promise<CloudExecResult> {
    const sb = await getSandbox(h.sandboxId);
    // Daytona's ExecuteResponse returns combined output in `result` with no
    // separate stderr stream. Surface it as stdout and leave stderr empty —
    // callers that need split streams must redirect inside `cmd` itself.
    const r = await sb.process.executeCommand(cmd, opts?.cwd, opts?.env);
    return { exitCode: r.exitCode, stdout: r.result, stderr: '' };
  },

  async uploadFile(h: CloudHandle, localPath: string, remotePath: string): Promise<void> {
    const sb = await getSandbox(h.sandboxId);
    await sb.fs.uploadFile(localPath, remotePath);
  },

  async downloadFile(h: CloudHandle, remotePath: string, localPath: string): Promise<void> {
    const sb = await getSandbox(h.sandboxId);
    await sb.fs.downloadFile(remotePath, localPath);
  },

  async listFiles(h: CloudHandle, remoteDir: string): Promise<CloudFileEntry[]> {
    const sb = await getSandbox(h.sandboxId);
    const files = await sb.fs.listFiles(remoteDir);
    return files.map((f) => ({
      name: f.name,
      isDir: Boolean((f as { isDir?: boolean }).isDir),
    }));
  },

  async previewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    const sb = await getSandbox(h.sandboxId);
    const p = await sb.getPreviewLink(port);
    // The host CloudBoxPoller attaches `token` as `x-daytona-preview-token`
    // for every /bridge call. The user-facing CLI `url` currently surfaces
    // only `url` — embedding the token for a browser is a Phase 6 polish.
    return { url: p.url, token: p.token };
  },
};
