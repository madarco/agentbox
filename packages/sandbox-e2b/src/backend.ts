/**
 * E2B `CloudBackend` — maps the provider-neutral cloud primitives onto the
 * `e2b` v2 SDK (Firecracker microVMs + pause/resume persistence). Composed
 * into a full `Provider` by `@agentbox/sandbox-cloud`'s `createCloudProvider`.
 *
 * Platform shape this backend is built around:
 *   - Boxes boot from the prepared base template baked by `agentbox prepare
 *     --provider e2b` (Template.build → custom Debian image with agentbox-ctl,
 *     the vscode user, /workspace, claude/codex/opencode, tmux, Chromium).
 *     `backend.provision` gates on `ensureE2bBaseTemplate()` (mirrors the
 *     hetzner/vercel pattern: `prepare` itself sidesteps the gate so a cold
 *     install can bootstrap). A snapshot ref (cloud checkpoint) wins over
 *     the prepared base.
 *   - No nested containers (Firecracker microVM); the provider sets
 *     `launchDockerd: false`.
 *   - Preview URLs (`{port}-{sandboxId}.{E2B_DOMAIN}`) are public HTTPS by
 *     default (allowPublicTraffic=true); no header token needed. We construct
 *     the URL string locally so `previewUrl` doesn't have to `Sandbox.connect`
 *     (which would auto-resume a paused box).
 *   - `Sandbox.getInfo` is a NON-resuming static API; `state()`/`get()` use it
 *     to check existence cheaply without waking a paused sandbox. Auto-resume
 *     happens only inside `Sandbox.connect` (used by ops that need a live
 *     handle: exec, file ops, pause, destroy).
 *   - `Sandbox.pause` is the canonical pause API (`betaPause` is deprecated).
 *   - `Sandbox.createSnapshot` is the reusable-snapshot primitive; the
 *     provider overrides the whole `checkpoint` capability in index.ts to
 *     store the resulting snapshot id (matching vercel's id-addressed shape).
 *   - No SSH — the provider overrides `buildAttach` with an SDK-streaming
 *     PTY bridge (`buildE2bAttach`); the legacy `attachArgv` slot stays
 *     unset.
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
import type { SandboxInfo, SandboxState } from './sdk.js';
import { Sandbox, Template, resolveApiKey } from './sdk.js';
import { withE2bRetry } from './retry.js';
import { ensureE2bBaseTemplate, readPreparedState } from './prepared-state.js';

/**
 * Sentinel image ref the cloud-provider hands us when no --image was passed.
 * Mirrors docker's convention; the actual template id is read from the
 * prepared-state file by `provision`.
 */
export const DEFAULT_BOX_IMAGE_REF = 'agentbox/box:dev';

/** Box user agentbox standardizes on (matches docker/vercel — created by build-template.sh). */
const BOX_USER = 'vscode';
const BOX_OWNER = 'vscode:vscode';

/** Default E2B preview hostname. Override via the SDK's `E2B_DOMAIN` env. */
const DEFAULT_E2B_DOMAIN = 'e2b.app';

/**
 * Per-box session timeout the SDK enforces. Past it, E2B auto-terminates the
 * sandbox; we explicitly extend via `sb.setTimeout` is not needed for Task 1's
 * smoke (boxes survive minutes, not hours). 45 min default mirrors vercel.
 */
const DEFAULT_TIMEOUT_MS = 45 * 60_000;

const E2B_WEB_PORT = 8080;

/** Single-quote a string for safe embedding inside a `bash -lc '<…>'`. */
function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Convert a Node `Buffer` to a plain `ArrayBuffer` because E2B's `files.write`
 * `data:` field is `string | ArrayBuffer | Blob | ReadableStream` — Buffer is a
 * `Uint8Array` subclass and doesn't satisfy that union at the type level (even
 * though it works at runtime). Copy rather than slice the underlying buffer:
 * Buffers may share an underlying ArrayBuffer with a pooled allocator, so
 * `data.buffer` of a small Buffer can be a megabyte-long shared region.
 */
function bufferToArrayBuffer(b: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(b.byteLength);
  new Uint8Array(ab).set(b);
  return ab;
}

/**
 * Map the SDK's nullable string state onto our 4-value `CloudState`.
 * E2B reports 'running' | 'paused' (per SDK types). Anything else (or absent)
 * → 'missing' so callers ping-pong the lifecycle into a clean state.
 */
function mapState(s: SandboxState | undefined): CloudState {
  switch (s) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    default:
      return 'missing';
  }
}

/** True when the error means "sandbox doesn't exist" (404). */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = err instanceof Error ? err.name : '';
  if (name === 'SandboxNotFoundError' || name === 'NotFoundError') return true;
  const status = (err as { statusCode?: unknown; status?: unknown }).statusCode ?? (err as { status?: unknown }).status;
  return status === 404;
}

/**
 * Sanitize a box name for use as the `metadata.name` value. E2B accepts
 * arbitrary strings (probed) but we strip control chars defensively so a name
 * with embedded newlines can't break log parsing or response shapes.
 */
function safeMetadataName(name: string): string {
  return name.replace(/[\u0000-\u001f]/g, '').slice(0, 200);
}

export const e2bBackend: CloudBackend = {
  name: 'e2b',

  // The cloud scaffold's WebProxy binds whatever port we expose here, and
  // `agentbox url --kind=web` resolves via `getHost(port)`. 8080 matches the
  // non-privileged convention vercel uses — `getHost` accepts any port, but
  // staying on 8080 keeps the in-box ctl flag (AGENTBOX_WEB_PROXY_PORT)
  // identical across cloud providers.
  webProxyPort: E2B_WEB_PORT,

  async provision(req: CloudProvisionRequest): Promise<CloudHandle> {
    const apiKey = resolveApiKey();
    const log = req.onLog ?? (() => {});
    // Resolve the template to boot from: an explicit cloud-checkpoint snapshot
    // (req.snapshot) wins, else the prepared base template id. We don't fall
    // back to E2B's stock `base` template — every box must have the agentbox
    // runtime baked in. The gate throws an actionable "run `agentbox prepare`"
    // error when no template is recorded yet (mirrors the hetzner/vercel
    // pattern: `prepare` itself sidesteps the gate by calling `prepareE2b`
    // directly, never `provision`).
    if (req.snapshot === undefined) {
      ensureE2bBaseTemplate();
    }
    const template = req.snapshot ?? readPreparedState().base?.templateId;
    if (!template) {
      throw new Error(
        'e2b provision: no template available — `agentbox prepare --provider e2b` must run first',
      );
    }

    // No-retry: Sandbox.create is billable and non-idempotent — a timeout
    // after the request reached the origin could leave a duplicate sandbox we
    // can't reference for cleanup.
    const sb = await withE2bRetry(
      { method: 'provision', retryOnAmbiguous: false, attemptTimeoutMs: 300_000, backoffMs: [] },
      async () =>
        Sandbox.create({
          apiKey,
          template,
          // Friendly name (so prune can see it) + the 'agentbox' marker so
          // `list()` can filter out sandboxes provisioned by other tooling.
          metadata: { agentbox: 'true', 'agentbox.name': safeMetadataName(req.name), name: safeMetadataName(req.name) },
          envs: req.env,
          timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }),
    );
    log(`e2b: created sandbox ${sb.sandboxId} (template ${template})`);
    return { sandboxId: sb.sandboxId };
  },

  async get(sandboxId: string): Promise<CloudHandle | null> {
    const apiKey = resolveApiKey();
    return withE2bRetry({ method: 'get', retryOnAmbiguous: true }, async () => {
      try {
        // Static, NON-resuming — won't wake a paused sandbox just to confirm
        // it exists (per orchestrator review #1: connect would auto-resume).
        await Sandbox.getInfo(sandboxId, { apiKey });
        return { sandboxId };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    });
  },

  async list(): Promise<CloudSandboxSummary[]> {
    const apiKey = resolveApiKey();
    return withE2bRetry({ method: 'list', retryOnAmbiguous: true }, async () => {
      const summaries: CloudSandboxSummary[] = [];
      // Default query returns both running and paused sandboxes. We filter
      // client-side to the ones we created (metadata.agentbox === 'true').
      for (const state of ['running', 'paused'] as const) {
        const paginator = Sandbox.list({ apiKey, query: { state: [state] } });
        while (paginator.hasNext) {
          const page = await paginator.nextItems();
          for (const info of page) {
            if (info.metadata?.['agentbox'] !== 'true') continue;
            const friendly =
              info.metadata?.['agentbox.name'] ?? info.metadata?.['name'];
            const summary: CloudSandboxSummary = { sandboxId: info.sandboxId, state };
            if (friendly) summary.name = friendly;
            const startedAt = info.startedAt;
            if (startedAt instanceof Date) summary.createdAt = startedAt.toISOString();
            summaries.push(summary);
          }
        }
      }
      return summaries;
    });
  },

  // E2B has no separate stop primitive — sandboxes are either running or
  // paused. start is therefore a connect-and-resume (auto-resume inside
  // Sandbox.connect handles a paused box transparently).
  async start(h: CloudHandle): Promise<void> {
    const apiKey = resolveApiKey();
    await withE2bRetry(
      { method: 'start', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      async () => {
        await Sandbox.connect(h.sandboxId, { apiKey });
      },
    );
  },

  // stop ≡ pause on E2B (the pause IS the cold-storage state).
  async stop(h: CloudHandle): Promise<void> {
    await this.pause(h);
  },

  async pause(h: CloudHandle): Promise<void> {
    const apiKey = resolveApiKey();
    await withE2bRetry(
      { method: 'pause', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      async () => {
        await Sandbox.pause(h.sandboxId, { apiKey });
      },
    );
  },

  async resume(h: CloudHandle): Promise<void> {
    await this.start(h);
  },

  async destroy(h: CloudHandle): Promise<void> {
    const apiKey = resolveApiKey();
    await withE2bRetry(
      { method: 'destroy', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      async () => {
        try {
          await Sandbox.kill(h.sandboxId, { apiKey });
        } catch (err) {
          if (isNotFound(err)) return; // idempotent
          throw err;
        }
      },
    );
  },

  async state(h: CloudHandle): Promise<CloudState> {
    const apiKey = resolveApiKey();
    return withE2bRetry({ method: 'state', retryOnAmbiguous: true }, async () => {
      try {
        const info: SandboxInfo = await Sandbox.getInfo(h.sandboxId, { apiKey });
        return mapState(info.state);
      } catch (err) {
        if (isNotFound(err)) return 'missing';
        throw err;
      }
    });
  },

  async exec(h: CloudHandle, cmd: string, opts?: CloudExecOptions): Promise<CloudExecResult> {
    const apiKey = resolveApiKey();
    // Default per-attempt cap is 5 min — covers the cloud scaffold's
    // workspace-seed/carry extracts (tar of thousands of files, chown -R).
    // Callers can shorten with opts.attemptTimeoutMs for snappier probes.
    const timeoutMs = opts?.attemptTimeoutMs ?? 300_000;
    return withE2bRetry(
      {
        method: 'exec',
        retryOnAmbiguous: opts?.noRetry ? false : true,
        attemptTimeoutMs: timeoutMs,
        backoffMs: opts?.noRetry ? [] : undefined,
      },
      async () => {
        // Connect for the live handle — auto-resumes a paused box, which is
        // the correct semantics for exec (caller wants the command to run).
        const sb = await Sandbox.connect(h.sandboxId, { apiKey });
        // E2B's `commands.run` accepts only 'root' | 'user' | 'vscode'…; any
        // unix username we create in the fixup is valid. Pass through.
        const user = (opts?.user ?? BOX_USER) as 'root' | 'user';
        try {
          const r = await sb.commands.run(cmd, {
            ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
            ...(opts?.env !== undefined ? { envs: opts.env } : {}),
            user,
            timeoutMs,
          });
          return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
        } catch (err) {
          // commands.run throws on non-zero exit; the CommandResult fields
          // (exitCode/stdout/stderr) hang off the error. Map back into our
          // CloudExecResult so callers see exit=1, not a thrown exception
          // (vercel/daytona/hetzner exec contract returns the result).
          if (err instanceof Error && err.name === 'CommandExitError') {
            const ce = err as unknown as {
              exitCode: number;
              stdout: string;
              stderr: string;
            };
            return { exitCode: ce.exitCode, stdout: ce.stdout ?? '', stderr: ce.stderr ?? '' };
          }
          throw err;
        }
      },
    );
  },

  async uploadFile(h: CloudHandle, localPath: string, remotePath: string): Promise<void> {
    const apiKey = resolveApiKey();
    await withE2bRetry(
      { method: 'uploadFile', retryOnAmbiguous: true, attemptTimeoutMs: 300_000 },
      async () => {
        const data = await readFile(localPath);
        const sb = await Sandbox.connect(h.sandboxId, { apiKey });
        await sb.files.write([{ path: remotePath, data: bufferToArrayBuffer(data) }]);
        // files.write writes as the default user; chown to vscode so reads
        // from the scaffold's `sudo -u vscode …` exec calls succeed. Best-
        // effort — a chown failure on a world-readable file is harmless.
        try {
          await sb.commands.run(`sudo -n chown ${BOX_OWNER} ${shq(remotePath)}`, {
            user: 'root',
            timeoutMs: 10_000,
          });
        } catch {
          // ignore — file is at least present and readable
        }
      },
    );
  },

  async downloadFile(h: CloudHandle, remotePath: string, localPath: string): Promise<void> {
    const apiKey = resolveApiKey();
    await withE2bRetry(
      { method: 'downloadFile', retryOnAmbiguous: true, attemptTimeoutMs: 300_000 },
      async () => {
        const sb = await Sandbox.connect(h.sandboxId, { apiKey });
        const bytes = await sb.files.read(remotePath, { format: 'bytes' });
        const { writeFile } = await import('node:fs/promises');
        await writeFile(localPath, Buffer.from(bytes));
      },
    );
  },

  async listFiles(h: CloudHandle, remoteDir: string): Promise<CloudFileEntry[]> {
    const apiKey = resolveApiKey();
    return withE2bRetry({ method: 'listFiles', retryOnAmbiguous: true }, async () => {
      const sb = await Sandbox.connect(h.sandboxId, { apiKey });
      const entries = await sb.files.list(remoteDir);
      return entries.map((e) => ({ name: e.name, isDir: e.type === 'dir' }));
    });
  },

  async previewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    // E2B's `sandbox.getHost(port)` is just string interpolation of
    // `${port}-${sandboxId}.${sandboxDomain}` — calling it via Sandbox.connect
    // would auto-resume a paused box (the SDK's documented behavior). The
    // domain defaults to `e2b.app` with `E2B_DOMAIN` as the override (matches
    // the SDK's `ConnectionConfig` default), so we construct the URL locally
    // and never wake the box for a UI/dashboard URL fetch.
    const domain = process.env.E2B_DOMAIN ?? DEFAULT_E2B_DOMAIN;
    return { url: `https://${String(port)}-${h.sandboxId}.${domain}`, token: undefined };
  },

  // Fewer params than the interface's (h, port, expiresInSeconds) is fine —
  // E2B preview URLs are already public + browser-usable; no per-URL TTL.
  async signedPreviewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    return this.previewUrl(h, port);
  },

  /**
   * Probe whether a snapshot (i.e. a template id) is still bootable. E2B's
   * snapshot ids look like `template-id:tag` or `team-slug/name:tag` — both
   * accepted by `Template.exists(name)`. Returns false on any lookup failure
   * (treated by the cloud-provider as "gone" so it falls back to a from-base
   * boot rather than 410ing the user).
   */
  async snapshotExists(snapshotName: string): Promise<boolean> {
    const apiKey = resolveApiKey();
    return withE2bRetry({ method: 'snapshotExists', retryOnAmbiguous: true }, async () => {
      try {
        return await Template.exists(snapshotName, { apiKey });
      } catch {
        return false;
      }
    });
  },
};
