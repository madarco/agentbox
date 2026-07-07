/**
 * The example provider's `CloudBackend` — maps the provider-neutral cloud
 * primitives onto `@vercel/sandbox` v2 (Firecracker microVMs + snapshots). This
 * is a faithful copy of the built-in Vercel backend, built ONLY on
 * `@madarco/agentbox-provider-sdk`, to prove a real cloud provider can be a plugin.
 * Composed into a full `Provider` by the SDK's `createCloudProvider`.
 *
 * Platform shape this backend is built around:
 *   - No custom image — sandboxes boot from a snapshot baked once by
 *     `agentbox prepare --provider example`. `provision` always needs a snapshot
 *     id (the prepared base, or a cloud-checkpoint snapshot).
 *   - No SSH — `attachArgv` is intentionally omitted; the provider overrides
 *     `buildAttach` with a Vercel-SDK-streaming helper instead.
 *   - In-box docker (DinD) is baked into the base snapshot; the cloud scaffold
 *     auto-starts dockerd on create/resume (`launchDockerd: true` in index.ts).
 *   - Persistent sandboxes auto-snapshot on stop and auto-resume on the next
 *     `Sandbox.get({ resume: true })`, which is how pause/resume map cleanly.
 *   - The sandbox's native user is `vercel-sandbox`; agentbox standardizes on
 *     `vscode`, created by provision.sh. So `exec` drops privileges to `vscode`
 *     (root -> `sudo -u vscode`) unless the caller asks for root, and
 *     `uploadFile` chowns to the box user after the SDK writes as `vercel-sandbox`.
 *   - Max 4 exposed ports: 8080 (WebProxy), 6080 (noVNC), 8788 (relay/ctl bridge).
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
} from '@madarco/agentbox-provider-sdk';
import type { NetworkPolicy } from '@vercel/sandbox';
import {
  ensureFreshCredentials,
  resolveCredentials,
  Sandbox,
  Snapshot,
  type SandboxType,
} from './sdk.js';
import { withVercelRetry } from './retry.js';
import { readPreparedState } from './prepared-state.js';

/** Sentinel image ref the cloud-provider hands us when no --image was passed. */
export const DEFAULT_BOX_IMAGE_REF = 'agentbox/box:dev';

/** Box user agentbox standardizes on. provision.sh creates it; chown targets it by name. */
const BOX_USER = 'vscode';
const BOX_OWNER = 'vscode:vscode';

/**
 * Base ports exposed at create. Vercel REJECTS privileged ports (<1024), so the
 * in-box WebProxy binds 8080 (set via `webProxyPort`) and we expose 8080 here.
 * The other two are 6080 (noVNC) and 8788 (the relay/ctl bridge the host poller
 * reaches). Ports are fixed at create, so 8080 must be in this base set.
 */
export const VERCEL_EXPOSED_PORTS = [8080, 6080, 8788] as const;

/** Vercel's hard per-sandbox exposed-port cap. */
export const VERCEL_MAX_PORTS = 4;

/**
 * Merge requested `expose:` service ports into the base set: drop privileged
 * (<1024) + out-of-range + dupes, preserve order, cap at Vercel's 4-port limit.
 */
export function buildExposedPorts(extra: readonly number[] | undefined): number[] {
  const ports = [...VERCEL_EXPOSED_PORTS] as number[];
  const seen = new Set<number>(ports);
  for (const p of extra ?? []) {
    if (ports.length >= VERCEL_MAX_PORTS) break;
    if (Number.isInteger(p) && p >= 1024 && p < 65_536 && !seen.has(p)) {
      ports.push(p);
      seen.add(p);
    }
  }
  return ports;
}

/**
 * Parse the network-policy config string into a Vercel `NetworkPolicy`.
 * `''`/unset -> undefined (SDK default = allow-all). `allow-all`/`deny-all` pass
 * through; anything else is a comma-separated domain allowlist `{ allow: [...] }`.
 */
export function parseNetworkPolicy(raw: string | undefined): NetworkPolicy | undefined {
  const v = (raw ?? '').trim();
  if (v === '') return undefined;
  if (v === 'allow-all' || v === 'deny-all') return v;
  const allow = v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return allow.length > 0 ? { allow } : undefined;
}

/**
 * Default per-session timeout. 45 min is the Hobby ceiling; persistent mode makes
 * a hit transparent (the VM auto-snapshots and auto-resumes on the next SDK call).
 */
const DEFAULT_TIMEOUT_MS = 45 * 60_000;

/**
 * Per-box snapshot retention. Keep one auto-snapshot, never expiring, so a
 * paused box can always resume. `deleteEvicted: false` is load-bearing: a box
 * boots from a shared snapshot that Vercel reports as its `currentSnapshotId`
 * until it takes its first auto-snapshot, so `deleteEvicted: true` would delete
 * the shared base/checkpoint every other box depends on.
 */
const KEEP_LAST_SNAPSHOTS = { count: 1, expiration: 0, deleteEvicted: false } as const;

function creds(): Partial<{ token: string; teamId: string; projectId: string }> {
  return resolveCredentials();
}

/** Single-quote a string for safe embedding inside a `bash -lc '<...>'`. */
function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function getSandbox(id: string): Promise<SandboxType> {
  return Sandbox.get({ name: id, resume: false, ...creds() });
}

async function maybeGetSandbox(id: string): Promise<SandboxType | null> {
  try {
    return await getSandbox(id);
  } catch {
    return null;
  }
}

/** Map Vercel's session status onto our 4-value `CloudState`. */
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
 * Build a `runCommand` invocation that runs `cmd` as the box user (`vscode`) by
 * default, or as root when requested. Always starts as root (`sudo: true`) so the
 * inner `sudo -u vscode` is reliably passwordless, then drops privileges.
 */
function buildRunCommand(
  cmd: string,
  opts?: CloudExecOptions,
): { cmd: string; args: string[]; sudo: boolean } {
  const prelude: string[] = [];
  if (opts?.cwd) prelude.push(`cd ${shq(opts.cwd)}`);
  for (const [k, v] of Object.entries(opts?.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new Error(`example exec: invalid env var name ${JSON.stringify(k)}`);
    }
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

export const exampleBackend: CloudBackend = {
  name: 'example',

  // Vercel rejects privileged ports and can't add a routable port to a running
  // sandbox. So the in-box WebProxy binds 8080 (exposed at create).
  webProxyPort: 8080,

  async provision(req: CloudProvisionRequest): Promise<CloudHandle> {
    await ensureFreshCredentials();
    // Resolve the snapshot to boot from: an explicit cloud-checkpoint snapshot
    // (req.snapshot) wins, else the prepared base. Vercel can't build from a
    // Dockerfile, so there is no image fallback — fail loud with the fix.
    const snapshotId = req.snapshot ?? readPreparedState().base?.snapshotId;
    if (!snapshotId) {
      throw new Error(
        'no base snapshot found for the example provider.\n' +
          'Run `agentbox prepare --provider example` first — it bakes a Vercel base ' +
          'snapshot (a one-time prerequisite, since Vercel cannot build from a Dockerfile).',
      );
    }
    const networkPolicy = parseNetworkPolicy(req.networkPolicy);
    // No-retry: Sandbox.create is billable and non-idempotent.
    const handle = await withVercelRetry(
      { method: 'provision', retryOnAmbiguous: false, attemptTimeoutMs: 900_000, backoffMs: [] },
      async () => {
        const sb = await Sandbox.create({
          name: req.name,
          source: { type: 'snapshot', snapshotId },
          resources: { vcpus: req.resources?.cpu ?? 2 },
          ports: buildExposedPorts(req.exposePorts),
          timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          env: req.env,
          tags: { agentbox: 'true', 'agentbox.name': req.name },
          persistent: true,
          snapshotExpiration: 0,
          keepLastSnapshots: { ...KEEP_LAST_SNAPSHOTS },
          ...(networkPolicy ? { networkPolicy } : {}),
          ...creds(),
        });
        return { sandboxId: sb.name };
      },
    );
    return handle;
  },

  async get(sandboxId: string): Promise<CloudHandle | null> {
    await ensureFreshCredentials();
    return withVercelRetry({ method: 'get', retryOnAmbiguous: true }, async () => {
      const sb = await maybeGetSandbox(sandboxId);
      return sb ? { sandboxId: sb.name } : null;
    });
  },

  async list(): Promise<CloudSandboxSummary[]> {
    await ensureFreshCredentials();
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
    await ensureFreshCredentials();
    await withVercelRetry(
      { method: 'start', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      async () => {
        // resume:true auto-resumes a persistent sandbox from its current snapshot.
        await Sandbox.get({ name: h.sandboxId, resume: true, ...creds() });
      },
    );
  },

  async stop(h: CloudHandle): Promise<void> {
    await ensureFreshCredentials();
    await withVercelRetry(
      { method: 'stop', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      async () => {
        const sb = await getSandbox(h.sandboxId);
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
    await ensureFreshCredentials();
    await withVercelRetry(
      { method: 'destroy', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      async () => {
        const sb = await maybeGetSandbox(h.sandboxId);
        if (!sb) return; // already gone — destroy is idempotent
        // Purge only a snapshot THIS box created, never the shared base/source it
        // booted from (deleting that would nuke the base every other box needs).
        const snapId = sb.currentSnapshotId;
        const source = sb.sourceSnapshotId;
        const base = readPreparedState().base?.snapshotId;
        const ownSnapshot = snapId !== undefined && snapId !== source && snapId !== base;
        await sb.delete();
        if (ownSnapshot) {
          try {
            const snap = await Snapshot.get({ snapshotId: snapId, ...creds() });
            await snap.delete();
          } catch {
            // best-effort: a snapshot already gone is fine.
          }
        }
      },
    );
  },

  async state(h: CloudHandle): Promise<CloudState> {
    await ensureFreshCredentials();
    return withVercelRetry({ method: 'state', retryOnAmbiguous: true }, async () => {
      const sb = await maybeGetSandbox(h.sandboxId);
      if (!sb) return 'missing';
      return mapState(sb.status);
    });
  },

  async exec(h: CloudHandle, cmd: string, opts?: CloudExecOptions): Promise<CloudExecResult> {
    await ensureFreshCredentials();
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
    await ensureFreshCredentials();
    await withVercelRetry(
      { method: 'uploadFile', retryOnAmbiguous: true, attemptTimeoutMs: 300_000 },
      async () => {
        const content = await readFile(localPath);
        const sb = await getSandbox(h.sandboxId);
        await sb.writeFiles([{ path: remotePath, content }]);
        // writeFiles writes as `vercel-sandbox`; chown to the box user. Best-effort.
        try {
          await sb.runCommand({ cmd: 'chown', args: [BOX_OWNER, remotePath], sudo: true });
        } catch {
          // ignore — file is at least present and readable
        }
      },
    );
  },

  async downloadFile(h: CloudHandle, remotePath: string, localPath: string): Promise<void> {
    await ensureFreshCredentials();
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
          throw new Error(`example downloadFile: source not found: ${remotePath}`);
        }
      },
    );
  },

  async listFiles(h: CloudHandle, remoteDir: string): Promise<CloudFileEntry[]> {
    await ensureFreshCredentials();
    return withVercelRetry({ method: 'listFiles', retryOnAmbiguous: true }, async () => {
      const sb = await getSandbox(h.sandboxId);
      const entries = await sb.fs.readdir(remoteDir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    });
  },

  async previewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    await ensureFreshCredentials();
    return withVercelRetry({ method: 'previewUrl', retryOnAmbiguous: true }, async () => {
      const sb = await getSandbox(h.sandboxId);
      // sb.domain(port) is a public HTTPS URL (no header token needed).
      return { url: sb.domain(port), token: undefined };
    });
  },

  async signedPreviewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    return this.previewUrl(h, port);
  },

  // Vercel `extendTimeout` is ADDITIVE and the remaining time isn't readable, so
  // the host passes its tracked deadline and we extend by the delta to land the
  // death-time at `target`. The host only calls when target > current.
  async renewTimeout(
    h: CloudHandle,
    targetDeadlineEpochMs: number,
    currentDeadlineEpochMs: number,
  ): Promise<void> {
    const deltaMs = Math.max(0, targetDeadlineEpochMs - currentDeadlineEpochMs);
    if (deltaMs === 0) return;
    await ensureFreshCredentials();
    await withVercelRetry({ method: 'renewTimeout', retryOnAmbiguous: true }, async () => {
      const sb = await getSandbox(h.sandboxId);
      await sb.extendTimeout(deltaMs);
    });
  },

  async snapshotExists(snapshotName: string): Promise<boolean> {
    await ensureFreshCredentials();
    return withVercelRetry({ method: 'snapshotExists', retryOnAmbiguous: true }, async () => {
      try {
        const snap = await Snapshot.get({ snapshotId: snapshotName, ...creds() });
        // `Snapshot.get` resolves deleted/failed tombstones (status field), so
        // "didn't throw" wrongly passes a dead snapshot. Only 'created' can boot.
        return snap.status === 'created';
      } catch {
        return false;
      }
    });
  },

  // NOTE: no `createSnapshot`/`deleteSnapshot` here. Vercel snapshots are
  // addressed by an opaque id (not a caller-chosen name), which doesn't fit the
  // CloudBackend `createSnapshot(handle, name): void` contract. The provider
  // therefore overrides the whole `checkpoint` capability in index.ts using
  // `snapshotExampleSandbox` / `deleteExampleSnapshot` below.
};

/**
 * Snapshot a running sandbox and return the resulting Vercel snapshot id.
 * `sb.snapshot()` stops the source sandbox as part of capture; persistent mode
 * resumes it on the next SDK call.
 */
export async function snapshotExampleSandbox(sandboxId: string): Promise<string> {
  await ensureFreshCredentials();
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
export async function deleteExampleSnapshot(snapshotId: string): Promise<void> {
  await ensureFreshCredentials();
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
