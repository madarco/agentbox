/**
 * `MockCloudBackend` — a fully in-memory implementation of `CloudBackend` for
 * tests and as a reference. New cloud backends (Vercel, Fly.io, …) can use
 * the contract suite in `test/contract.ts` to validate that their backend
 * behaves the way `createCloudProvider` expects, and look at this file as a
 * minimal example.
 *
 * Behavior is intentionally simple — every method records the call (so
 * tests can assert ordering) and resolves with deterministic values. No
 * I/O. The implementation covers every required method on `CloudBackend`
 * plus every optional one, so contract tests can exercise both branches.
 */

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

interface SandboxRecord {
  id: string;
  name: string;
  state: CloudState;
  createdAt: string;
  image: string;
  /** Pseudo-file content keyed by remote path. */
  files: Map<string, Uint8Array>;
}

export interface MockCloudBackendOptions {
  /** Name reported by `backend.name`. Defaults to `'mock'`. */
  name?: string;
  /** Initial sandboxes pre-loaded into the backend (e.g. for list() tests). */
  preloaded?: Array<{ id: string; name?: string; state?: CloudState; createdAt?: string }>;
  /**
   * Optional hook fired before every method runs. Tests can use this to
   * inject failures (`throw new Error(...)` or a typed Daytona-shaped error
   * to exercise the retry wrapper).
   */
  beforeCall?: (method: string, args: unknown[]) => void | Promise<void>;
}

export interface MockCloudBackend extends CloudBackend {
  /** Method names captured in invocation order — useful for assertions. */
  readonly calls: ReadonlyArray<{ method: string; args: unknown[] }>;
  /** Sandboxes currently present in the backend (post any provision/destroy). */
  readonly sandboxes: ReadonlyArray<Readonly<SandboxRecord>>;
}

/** Make a fresh mock backend. Always returns a brand-new internal state. */
export function makeMockCloudBackend(opts: MockCloudBackendOptions = {}): MockCloudBackend {
  const name = opts.name ?? 'mock';
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const sandboxes = new Map<string, SandboxRecord>();
  const snapshots = new Map<string, { id: string }>();

  for (const pre of opts.preloaded ?? []) {
    sandboxes.set(pre.id, {
      id: pre.id,
      name: pre.name ?? pre.id,
      state: pre.state ?? 'running',
      createdAt: pre.createdAt ?? new Date().toISOString(),
      image: 'mock/preloaded',
      files: new Map(),
    });
  }

  const record = async (method: string, args: unknown[]): Promise<void> => {
    calls.push({ method, args });
    if (opts.beforeCall) await opts.beforeCall(method, args);
  };
  const requireSandbox = (id: string): SandboxRecord => {
    const sb = sandboxes.get(id);
    if (!sb) throw new Error(`mock backend: sandbox ${id} not found`);
    return sb;
  };

  const backend: MockCloudBackend = {
    name,
    get calls() {
      return calls;
    },
    get sandboxes() {
      return Array.from(sandboxes.values());
    },

    async provision(req: CloudProvisionRequest): Promise<CloudHandle> {
      await record('provision', [req]);
      const id = `mock-${String(sandboxes.size + 1)}-${req.name}`;
      sandboxes.set(id, {
        id,
        name: req.name,
        state: 'running',
        createdAt: new Date().toISOString(),
        image: req.snapshot ?? req.image,
        files: new Map(),
      });
      return { sandboxId: id };
    },

    async get(sandboxId: string): Promise<CloudHandle | null> {
      await record('get', [sandboxId]);
      return sandboxes.has(sandboxId) ? { sandboxId } : null;
    },

    async list(): Promise<CloudSandboxSummary[]> {
      await record('list', []);
      return Array.from(sandboxes.values()).map((sb) => ({
        sandboxId: sb.id,
        name: sb.name,
        createdAt: sb.createdAt,
        state: sb.state,
      }));
    },

    async start(h: CloudHandle): Promise<void> {
      await record('start', [h]);
      const sb = requireSandbox(h.sandboxId);
      sb.state = 'running';
    },
    async stop(h: CloudHandle): Promise<void> {
      await record('stop', [h]);
      const sb = requireSandbox(h.sandboxId);
      sb.state = 'stopped';
    },
    async pause(h: CloudHandle): Promise<void> {
      await record('pause', [h]);
      const sb = requireSandbox(h.sandboxId);
      sb.state = 'paused';
    },
    async resume(h: CloudHandle): Promise<void> {
      await record('resume', [h]);
      const sb = requireSandbox(h.sandboxId);
      sb.state = 'running';
    },
    async destroy(h: CloudHandle): Promise<void> {
      await record('destroy', [h]);
      sandboxes.delete(h.sandboxId);
    },
    async state(h: CloudHandle): Promise<CloudState> {
      await record('state', [h]);
      const sb = sandboxes.get(h.sandboxId);
      return sb ? sb.state : 'missing';
    },

    async exec(
      h: CloudHandle,
      cmd: string,
      opts?: CloudExecOptions,
    ): Promise<CloudExecResult> {
      await record('exec', [h, cmd, opts]);
      requireSandbox(h.sandboxId);
      return { exitCode: 0, stdout: '', stderr: '' };
    },

    async uploadFile(h: CloudHandle, localPath: string, remotePath: string): Promise<void> {
      await record('uploadFile', [h, localPath, remotePath]);
      const sb = requireSandbox(h.sandboxId);
      sb.files.set(remotePath, new Uint8Array([0]));
    },
    async downloadFile(h: CloudHandle, remotePath: string, localPath: string): Promise<void> {
      await record('downloadFile', [h, remotePath, localPath]);
      const sb = requireSandbox(h.sandboxId);
      if (!sb.files.has(remotePath)) {
        throw new Error(`mock backend: ${remotePath} not in sandbox ${h.sandboxId}`);
      }
    },
    async listFiles(h: CloudHandle, remoteDir: string): Promise<CloudFileEntry[]> {
      await record('listFiles', [h, remoteDir]);
      const sb = requireSandbox(h.sandboxId);
      const prefix = remoteDir.endsWith('/') ? remoteDir : `${remoteDir}/`;
      const out: CloudFileEntry[] = [];
      for (const p of sb.files.keys()) {
        if (p.startsWith(prefix)) {
          out.push({ name: p.slice(prefix.length), isDir: false });
        }
      }
      return out;
    },

    async previewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
      await record('previewUrl', [h, port]);
      requireSandbox(h.sandboxId);
      return { url: `https://${String(port)}-${h.sandboxId}.mock.preview`, token: 'mock-token' };
    },

    async signedPreviewUrl(
      h: CloudHandle,
      port: number,
      expiresInSeconds: number,
    ): Promise<CloudPreviewUrl> {
      await record('signedPreviewUrl', [h, port, expiresInSeconds]);
      requireSandbox(h.sandboxId);
      return {
        url: `https://${String(port)}-${h.sandboxId}-signed${String(expiresInSeconds)}.mock.preview`,
      };
    },

    async attachArgv(h: CloudHandle): Promise<string[]> {
      await record('attachArgv', [h]);
      requireSandbox(h.sandboxId);
      return ['ssh', '-o', 'StrictHostKeyChecking=no', `mock-token@${h.sandboxId}.mock.ssh`];
    },

    async revokeAttachToken(h: CloudHandle, argv: string[]): Promise<void> {
      await record('revokeAttachToken', [h, argv]);
    },

    async ensureVolume(volumeName: string): Promise<{ volumeId: string }> {
      await record('ensureVolume', [volumeName]);
      return { volumeId: `vol-${volumeName}` };
    },

    async createSnapshot(h: CloudHandle, snapshotName: string): Promise<void> {
      await record('createSnapshot', [h, snapshotName]);
      requireSandbox(h.sandboxId);
      snapshots.set(snapshotName, { id: snapshotName });
    },

    async deleteSnapshot(snapshotName: string): Promise<void> {
      await record('deleteSnapshot', [snapshotName]);
      snapshots.delete(snapshotName);
    },
  };

  return backend;
}
