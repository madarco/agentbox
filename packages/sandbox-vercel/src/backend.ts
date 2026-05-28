/**
 * Vercel `CloudBackend` — maps the provider-neutral cloud primitives onto
 * `@vercel/sandbox` v2 (Firecracker microVMs + snapshots). Composed into a full
 * `Provider` by `@agentbox/sandbox-cloud`'s `createCloudProvider`.
 *
 * Platform shape this backend is built around (see docs/cloud-providers.md):
 *   - No custom image — sandboxes boot from a Vercel snapshot baked once by
 *     `agentbox prepare --provider vercel`. `provision` always needs a snapshot
 *     id (the prepared base, or a cloud-checkpoint snapshot).
 *   - No SSH — `attachArgv` is intentionally omitted; the provider overrides
 *     `buildAttach` with a Vercel-SDK-streaming helper instead.
 *   - No nested containers — dockerd is disabled at the provider level.
 *   - Persistent sandboxes auto-snapshot on stop and auto-resume on the next
 *     `Sandbox.get({ resume: true })`, which is how pause/resume map cleanly.
 *   - The sandbox's native user is `vercel-sandbox`; agentbox standardizes on
 *     `vscode` (uid 1000), created by provision.sh. So `exec` drops privileges
 *     to `vscode` (root → `sudo -u vscode`) unless the caller asks for root,
 *     and `uploadFile` chowns to uid 1000 after the SDK writes as
 *     `vercel-sandbox`.
 *   - Max 4 exposed ports: we use 80 (WebProxy), 6080 (noVNC), 8788 (relay/ctl
 *     bridge). One slot is left free for a future per-service expose.
 */

import { readFile } from 'node:fs/promises';
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
import { resolveCredentials, Sandbox, Snapshot, type SandboxType } from './sdk.js';
import { withVercelRetry } from './retry.js';
import { readPreparedState } from './prepared-state.js';

/** Sentinel image ref the cloud-provider hands us when no --image was passed. */
export const DEFAULT_BOX_IMAGE_REF = 'agentbox/box:dev';

/** Box user agentbox standardizes on. provision.sh creates it (uid auto-assigned —
 * the Vercel default user may already hold 1000, and there are no bind mounts so
 * the exact uid is irrelevant). chown targets it by name, not number. */
const BOX_USER = 'vscode';
const BOX_OWNER = 'vscode:vscode';

/**
 * Ports exposed at create (max 4). Vercel REJECTS privileged ports (<1024) with
 * a 400, so we cannot expose the scaffold's WebProxy port 80 — the two ports
 * that matter are 6080 (noVNC) and 8788 (the relay/ctl bridge the host poller
 * reaches via `sandbox.domain(8788)`). The in-box WebProxy still binds 80, but
 * it isn't externally reachable on Vercel, so `agentbox url` for a web app is a
 * documented v1 limitation (see docs/vercel-backlog.md). A 4th slot is free for
 * a future non-privileged per-service expose.
 */
export const VERCEL_EXPOSED_PORTS = [6080, 8788] as const;

/**
 * Default per-session timeout. 45 min is the Hobby ceiling, so it's safe across
 * all plans; persistent mode makes a hit transparent (the VM auto-snapshots and
 * auto-resumes on the next SDK call). Pro/Enterprise users who want a longer
 * single session can rely on `extendTimeout` / future config.
 */
const DEFAULT_TIMEOUT_MS = 45 * 60_000;

/** Keep exactly one auto-snapshot per box, never expiring, so a paused box can
 * always resume and storage stays flat. `destroy` purges it explicitly. */
const KEEP_LAST_SNAPSHOTS = { count: 1, expiration: 0, deleteEvicted: true } as const;

function creds(): Partial<{ token: string; teamId: string; projectId: string }> {
  return resolveCredentials();
}

/** Single-quote a string for safe embedding inside a `bash -lc '<…>'`. */
function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function getSandbox(id: string): Promise<SandboxType> {
  // resume:false — plain handle resolution; lifecycle methods opt into resume.
  return Sandbox.get({ name: id, resume: false, ...creds() });
}

async function maybeGetSandbox(id: string): Promise<SandboxType | null> {
  try {
    return await getSandbox(id);
  } catch {
    return null;
  }
}

/**
 * Map Vercel's session status onto our 4-value `CloudState`. Transitional
 * states report as 'running' so callers don't ping-pong; 'stopped' maps to
 * 'paused' because a persistent sandbox keeps an auto-snapshot and resumes on
 * the next call (our pause semantics). 'aborted'/'failed' → 'missing'.
 */
function mapState(s: string | undefined): CloudState {
  switch (s) {
    case 'running':
      return 'running';
    case 'pending':
    case 'stopping':
    case 'snapshotting':
      return 'running';
    case 'stopped':
      return 'paused';
    case 'aborted':
    case 'failed':
    default:
      return 'missing';
  }
}

/**
 * Build a `runCommand` invocation that runs `cmd` (already a shell string) as
 * the box user (`vscode`) by default, or as root when requested. Always starts
 * the SDK command as root (`sudo: true`) so the inner `sudo -u vscode` is
 * reliably passwordless, then drops privileges. cwd + env are applied inside
 * the dropped shell so they land in the right user/home context.
 */
function buildRunCommand(
  cmd: string,
  opts?: CloudExecOptions,
): { cmd: string; args: string[]; sudo: boolean } {
  const prelude: string[] = [];
  if (opts?.cwd) prelude.push(`cd ${shq(opts.cwd)}`);
  for (const [k, v] of Object.entries(opts?.env ?? {})) {
    prelude.push(`export ${k}=${shq(v)}`);
  }
  const inner = [...prelude, cmd].join('\n');
  const user = opts?.user ?? BOX_USER;
  if (user === 'root') {
    return { cmd: 'bash', args: ['-lc', inner], sudo: true };
  }
  return {
    cmd: 'bash',
    args: ['-lc', `sudo -u ${user} -H bash -lc ${shq(inner)}`],
    sudo: true,
  };
}

export const vercelBackend: CloudBackend = {
  name: 'vercel',

  async provision(req: CloudProvisionRequest): Promise<CloudHandle> {
    // Resolve the snapshot to boot from: an explicit cloud-checkpoint snapshot
    // (req.snapshot) wins, else the prepared base. Vercel can't build from a
    // Dockerfile, so there is no image fallback — fail loud with the fix.
    const snapshotId = req.snapshot ?? readPreparedState().base?.snapshotId;
    if (!snapshotId) {
      throw new Error(
        'no Vercel base snapshot found.\n' +
          'Run `agentbox prepare --provider vercel` first — Vercel cannot build images ' +
          'from a Dockerfile, so the base snapshot is a one-time prerequisite.',
      );
    }
    // No-retry: Sandbox.create is billable and non-idempotent — a timeout after
    // the request reached the origin could leave a duplicate sandbox we can't
    // reference for cleanup.
    return withVercelRetry(
      { method: 'provision', retryOnAmbiguous: false, attemptTimeoutMs: 900_000, backoffMs: [] },
      async () => {
        const sb = await Sandbox.create({
          name: req.name,
          source: { type: 'snapshot', snapshotId },
          resources: { vcpus: req.resources?.cpu ?? 2 },
          ports: [...VERCEL_EXPOSED_PORTS],
          timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          env: req.env,
          tags: { agentbox: 'true', 'agentbox.name': req.name },
          persistent: true,
          keepLastSnapshots: { ...KEEP_LAST_SNAPSHOTS },
          ...creds(),
        });
        return { sandboxId: sb.name };
      },
    );
  },

  async get(sandboxId: string): Promise<CloudHandle | null> {
    return withVercelRetry({ method: 'get', retryOnAmbiguous: true }, async () => {
      const sb = await maybeGetSandbox(sandboxId);
      return sb ? { sandboxId: sb.name } : null;
    });
  },

  async list(): Promise<CloudSandboxSummary[]> {
    return withVercelRetry({ method: 'list', retryOnAmbiguous: true }, async () => {
      const page = await Sandbox.list({ ...creds() });
      const items = await page.toArray();
      return items
        .filter((sb) => sb.tags?.['agentbox'] === 'true')
        .map((sb): CloudSandboxSummary => {
          const summary: CloudSandboxSummary = { sandboxId: sb.name };
          const friendly = sb.tags?.['agentbox.name'] ?? sb.name;
          if (friendly) summary.name = friendly;
          if (typeof sb.createdAt === 'number') {
            summary.createdAt = new Date(sb.createdAt).toISOString();
          }
          summary.state = mapState(sb.status);
          return summary;
        });
    });
  },

  async start(h: CloudHandle): Promise<void> {
    await withVercelRetry(
      { method: 'start', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      async () => {
        // resume:true auto-resumes a persistent sandbox from its current snapshot.
        await Sandbox.get({ name: h.sandboxId, resume: true, ...creds() });
      },
    );
  },

  async stop(h: CloudHandle): Promise<void> {
    await withVercelRetry(
      { method: 'stop', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      async () => {
        const sb = await getSandbox(h.sandboxId);
        // For a persistent sandbox this captures an auto-snapshot and shuts the
        // VM down — resume happens lazily on the next Sandbox.get.
        await sb.stop();
      },
    );
  },

  // pause == stop on Vercel (the auto-snapshot IS the cold-storage state).
  async pause(h: CloudHandle): Promise<void> {
    await this.stop(h);
  },

  async resume(h: CloudHandle): Promise<void> {
    await this.start(h);
  },

  async destroy(h: CloudHandle): Promise<void> {
    await withVercelRetry(
      { method: 'destroy', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      async () => {
        const sb = await maybeGetSandbox(h.sandboxId);
        if (!sb) return; // already gone — destroy is idempotent
        // Purge only a snapshot THIS box created (its own stop-time auto-
        // snapshot), never the shared base/source it booted from. A fresh box
        // has currentSnapshotId === sourceSnapshotId === the prepared base, and
        // deleting that would nuke the base snapshot every other box depends on.
        const snapId = sb.currentSnapshotId;
        const source = sb.sourceSnapshotId;
        const base = readPreparedState().base?.snapshotId;
        const ownSnapshot =
          snapId !== undefined && snapId !== source && snapId !== base;
        await sb.delete();
        if (ownSnapshot) {
          try {
            const snap = await Snapshot.get({ snapshotId: snapId, ...creds() });
            await snap.delete();
          } catch {
            // best-effort: a snapshot already gone is fine; the user can clean
            // stragglers from the Vercel dashboard.
          }
        }
      },
    );
  },

  async state(h: CloudHandle): Promise<CloudState> {
    return withVercelRetry({ method: 'state', retryOnAmbiguous: true }, async () => {
      const sb = await maybeGetSandbox(h.sandboxId);
      if (!sb) return 'missing';
      return mapState(sb.status);
    });
  },

  async exec(h: CloudHandle, cmd: string, opts?: CloudExecOptions): Promise<CloudExecResult> {
    return withVercelRetry(
      {
        method: 'exec',
        retryOnAmbiguous: opts?.noRetry ? false : true,
        attemptTimeoutMs: opts?.attemptTimeoutMs ?? 120_000,
        backoffMs: opts?.noRetry ? [] : undefined,
      },
      async () => {
        const sb = await getSandbox(h.sandboxId);
        const r = await sb.runCommand(buildRunCommand(cmd, opts));
        const [stdout, stderr] = await Promise.all([r.stdout(), r.stderr()]);
        return { exitCode: r.exitCode, stdout, stderr };
      },
    );
  },

  async uploadFile(h: CloudHandle, localPath: string, remotePath: string): Promise<void> {
    await withVercelRetry(
      { method: 'uploadFile', retryOnAmbiguous: true, attemptTimeoutMs: 300_000 },
      async () => {
        const content = await readFile(localPath);
        const sb = await getSandbox(h.sandboxId);
        await sb.writeFiles([{ path: remotePath, content }]);
        // writeFiles writes as `vercel-sandbox`; chown to the box user so the
        // scaffold's vscode-context reads/extractions succeed. Best-effort —
        // a chown failure on a world-readable /tmp staging file is harmless.
        try {
          await sb.runCommand({ cmd: 'chown', args: [BOX_OWNER, remotePath], sudo: true });
        } catch {
          // ignore — file is at least present and readable
        }
      },
    );
  },

  async downloadFile(h: CloudHandle, remotePath: string, localPath: string): Promise<void> {
    await withVercelRetry(
      { method: 'downloadFile', retryOnAmbiguous: true, attemptTimeoutMs: 300_000 },
      async () => {
        const sb = await getSandbox(h.sandboxId);
        const written = await sb.downloadFile(
          { path: remotePath },
          { path: localPath },
          { mkdirRecursive: true },
        );
        if (written === null) {
          throw new Error(`vercel downloadFile: source not found: ${remotePath}`);
        }
      },
    );
  },

  async listFiles(h: CloudHandle, remoteDir: string): Promise<CloudFileEntry[]> {
    return withVercelRetry({ method: 'listFiles', retryOnAmbiguous: true }, async () => {
      const sb = await getSandbox(h.sandboxId);
      const entries = await sb.fs.readdir(remoteDir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    });
  },

  async previewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    return withVercelRetry({ method: 'previewUrl', retryOnAmbiguous: true }, async () => {
      const sb = await getSandbox(h.sandboxId);
      // sb.domain(port) is a public HTTPS URL (no header token needed).
      return { url: sb.domain(port), token: undefined };
    });
  },

  // Fewer params than the interface's (h, port, expiresInSeconds) is fine —
  // Vercel sandbox domains are already public + browser-usable, so the signed
  // URL is just the standard one (the TTL is governed by the sandbox session
  // lifetime, not a per-URL signature, so the expiry arg is irrelevant here).
  async signedPreviewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    return this.previewUrl(h, port);
  },

  // NOTE: no `createSnapshot`/`deleteSnapshot` here. Vercel snapshots are
  // addressed by an opaque id (not a caller-chosen name), which doesn't fit the
  // CloudBackend `createSnapshot(handle, name): void` contract — the provider
  // needs the id back to store it in the checkpoint manifest. The Vercel
  // provider therefore overrides the whole `checkpoint` capability in index.ts
  // using `snapshotVercelSandbox` / `deleteVercelSnapshot` below.
};

/**
 * Snapshot a running sandbox and return the resulting Vercel snapshot id.
 * `sb.snapshot()` stops the source sandbox as part of capture; persistent mode
 * resumes it on the next SDK call, so the box comes back automatically.
 */
export async function snapshotVercelSandbox(sandboxId: string): Promise<string> {
  return withVercelRetry(
    { method: 'createSnapshot', retryOnAmbiguous: false, attemptTimeoutMs: 900_000, backoffMs: [] },
    async () => {
      const sb = await getSandbox(sandboxId);
      const snap = await sb.snapshot({ expiration: 0 });
      return snap.snapshotId;
    },
  );
}

/** Delete a Vercel snapshot by id. Idempotent — a missing snapshot is success. */
export async function deleteVercelSnapshot(snapshotId: string): Promise<void> {
  await withVercelRetry({ method: 'deleteSnapshot', retryOnAmbiguous: true }, async () => {
    try {
      const snap = await Snapshot.get({ snapshotId, ...creds() });
      await snap.delete();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not.?found|404/i.test(msg)) return; // idempotent
      throw err;
    }
  });
}
