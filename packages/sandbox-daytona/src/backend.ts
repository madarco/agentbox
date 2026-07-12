/**
 * Daytona `CloudBackend` — maps the provider-neutral cloud primitives onto
 * `@daytona/sdk`. Lazy SDK client + lazy sandbox handle resolution so
 * importing this module costs nothing until a daytona-tagged box does something.
 */

import { Daytona, DaytonaNotFoundError, Image, SandboxState, type Sandbox } from '@daytona/sdk';
import type { CloudSandboxSummary } from '@agentbox/core';
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
import { readPreparedDaytonaState } from './prepared-state.js';
import { waitForSnapshotActive } from './snapshot-wait.js';
import { withDaytonaRetry } from './retry.js';

/**
 * Thin shorthand for `withDaytonaRetry` with our defaults. Most methods are
 * idempotent and use `retryOnAmbiguous: true`; the few that aren't override.
 */
function retry<T>(
  method: string,
  fn: () => Promise<T>,
  opts: {
    attemptTimeoutMs?: number;
    retryOnAmbiguous?: boolean;
    /** When true, single-shot — no backoff list, no retries. */
    noRetry?: boolean;
  } = {},
): Promise<T> {
  return withDaytonaRetry(
    {
      method,
      retryOnAmbiguous: opts.retryOnAmbiguous ?? true,
      attemptTimeoutMs: opts.attemptTimeoutMs,
      backoffMs: opts.noRetry === true ? [] : undefined,
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

/**
 * Default sandbox shape — matches Daytona's own `daytona-vm-medium` preset.
 *
 * This MUST be passed explicitly at snapshot-create time. Daytona's true default
 * for a snapshot with no `resources` is 1 vCPU / 1 GiB / **3 GiB disk**, and the
 * box image doesn't fit in 3 GiB: the snapshot build dies mid-pull with a bare
 * "internal error".
 */
export const DAYTONA_DEFAULT_RESOURCES = { cpu: 2, memory: 4, disk: 8 } as const;

/**
 * Clients keyed by region target ('' = the account default).
 *
 * Region only matters for **create**: `Daytona.create()` places the sandbox in
 * its *client's* target region (the `regionId` create param is ignored), and
 * only `us-east-1` has linux-vm runners. Everything else — `get`, `exec`,
 * `list`, start/stop/pause/delete — is region-agnostic: a default-target client
 * reaches a `us-east-1` sandbox fine and `list()` spans regions (verified
 * 2026-07-12). So the rest of the backend can keep using the default client and
 * only `provision` asks for a targeted one.
 */
const clients = new Map<string, Daytona>();

export function getClient(target = ''): Daytona {
  const cached = clients.get(target);
  if (cached) return cached;
  // Pull DAYTONA_* keys from `.env.local` / `.env` / `~/.agentbox/secrets.env`
  // into process.env first — the SDK reads from process.env and most users
  // keep secrets in a project file rather than their shell rc.
  ensureDaytonaEnvLoaded();
  try {
    // Daytona() reads DAYTONA_API_KEY / DAYTONA_JWT_TOKEN + DAYTONA_ORGANIZATION_ID
    // from env.
    const created = target.length > 0 ? new Daytona({ target }) : new Daytona();
    clients.set(target, created);
    return created;
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
 * Map Daytona's `SandboxState` (fine-grained, incl. transitional values) onto
 * our 4-value `CloudState`. Transitional states ('starting', 'creating') are
 * reported as 'running' so callers don't ping-pong.
 *
 * Both of Daytona's cold states collapse to our 'paused': `archived` is what a
 * container box gets (our pause == Daytona's archive), `paused` is the real
 * VM freeze. A linux-vm box can never be archived and a container box can never
 * be paused, so the two are mutually exclusive per box — see `pause()`.
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
    case SandboxState.RESUMING:
      return 'running';
    case SandboxState.STOPPED:
      return 'stopped';
    case SandboxState.ARCHIVED:
    case SandboxState.ARCHIVING:
    case SandboxState.PAUSED:
    case SandboxState.PAUSING:
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

/**
 * Parse a `cpu-memory-disk` GB size spec (e.g. `4-8-20`) into Daytona's
 * `resources` shape. Returns `undefined` on any malformed input — three
 * positive integer slots are required.
 */
export function parseDaytonaSize(
  spec: string | undefined,
): { cpu: number; memory: number; disk: number } | undefined {
  if (!spec) return undefined;
  const parts = spec.trim().split('-');
  if (parts.length !== 3) return undefined;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n <= 0)) return undefined;
  return { cpu: nums[0]!, memory: nums[1]!, disk: nums[2]! };
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
        // Two SDK overloads:
        //   - `CreateSandboxFromSnapshotParams` takes `snapshot:` and no
        //     `onSnapshotCreateLogs` (the snapshot already exists, nothing to build).
        //   - `CreateSandboxFromImageParams` takes `image:` and accepts
        //     `onSnapshotCreateLogs` for streaming the Dockerfile build.
        // TypeScript can't infer the right overload from a union literal, so
        // split the call.
        // A `--size` / `box.sizeDaytona` like `4-8-20` overrides the default
        // resources. Note: Daytona rejects `resources` on the snapshot path
        // (stripped below), so this only takes effect when creating from an
        // image — snapshot-resume keeps the snapshot's baked-in resources.
        let sizeResources: { cpu: number; memory: number; disk: number } | undefined;
        if (req.size && req.size.length > 0) {
          sizeResources = parseDaytonaSize(req.size);
          if (!sizeResources) {
            req.onLog?.(
              `daytona: ignoring invalid size '${req.size}' (expected 'cpu-memory-disk' GB, e.g. '4-8-20')`,
            );
          }
        }
        const resources = sizeResources ?? req.resources;
        const baseParams = {
          ...(resources ? { resources } : {}),
          envVars: req.env,
          ...(req.volumes && req.volumes.length > 0
            ? { volumes: req.volumes.map(toDaytonaVolumeMount) }
            : {}),
          labels: { 'agentbox.name': req.name },
          // Daytona auto-stops a sandbox after N minutes of INACTIVITY (its own
          // default is 15). The host keepalive loop pushes this forward via
          // `renewTimeout` while an agent is working, so only a genuinely idle
          // box lapses. 0 disables it entirely.
          ...(typeof req.timeoutMs === 'number'
            ? { autoStopInterval: Math.max(0, Math.round(req.timeoutMs / 60_000)) }
            : {}),
        };
        // `create` places the sandbox in its CLIENT's region — the `regionId`
        // create param is ignored — and only `us-east-1` has linux-vm runners.
        const client = getClient(req.location ?? '');
        // The first-time Dockerfile.box snapshot build is ~41 layers and pulls
        // Chromium — comfortably 5+ minutes wall time. Daytona's default ready
        // timeout is too short for that; override with 15 min so a cold build
        // doesn't fail mid-snapshot. Cached snapshots and snapshot-based
        // creates come up in seconds.
        // Resolve `req.image` against Daytona's snapshot registry first when
        // it's set to a non-default value: `agentbox prepare --provider
        // daytona` registers a named snapshot and writes `box.image:
        // <name>` into project config; subsequent creates should boot from
        // that snapshot, not try to pull `<name>:latest` from Docker Hub.
        // Default ref (agentbox/box:dev) skips the lookup and goes through
        // resolveImage (Image.fromDockerfile). Explicit `req.snapshot` always
        // wins (cloud checkpoint path).
        let snapshotName = req.snapshot;
        if (!snapshotName && req.image && req.image !== DEFAULT_BOX_IMAGE_REF) {
          try {
            const snap = await client.snapshot.get(req.image);
            if (snap && snap.name) snapshotName = snap.name;
          } catch {
            // Not a known snapshot — fall through and treat as a Docker image ref.
          }
        }
        // Daytona rejects `resources` on the snapshot path — the snapshot's
        // own params encode them. Strip resources only for the snapshot
        // branch; the image branch keeps them.
        const snapshotParams: Record<string, unknown> = { ...baseParams };
        delete snapshotParams.resources;
        // On the snapshot path the size is fixed at bake time. If the user asked
        // for a size that differs from what the snapshot was baked with, warn
        // loudly — silently ignoring `--size` would leave them wondering why the
        // box came up the old size.
        if (snapshotName && sizeResources) {
          const bakedSize = readPreparedDaytonaState()?.extras?.size;
          const requestedKey = `${String(sizeResources.cpu)}-${String(sizeResources.memory)}-${String(sizeResources.disk)}`;
          if (bakedSize !== requestedKey) {
            req.onLog?.(
              `daytona: WARNING — size '${requestedKey}' is ignored on the snapshot path; ` +
                `this snapshot was baked at ${bakedSize ?? 'the default size'}. ` +
                `Daytona resources are fixed at bake time — re-bake with ` +
                `\`agentbox prepare --provider daytona --size ${requestedKey} --force\` to change them.`,
            );
          }
        }
        // The image path builds a Dockerfile through Daytona's declarative
        // builder, which is CONTAINER-ONLY. Falling through to it when the user
        // asked for a VM would hand them a container box that silently can't
        // pause — so refuse, and point at the bake that produces a VM base.
        if (!snapshotName && req.sandboxClass === 'linux-vm') {
          throw new Error(
            `no linux-vm base snapshot for daytona: Daytona can only build a VM snapshot from a ` +
              `prebuilt image, not from a Dockerfile, so there is nothing to boot.\n` +
              `Run \`agentbox prepare --provider daytona\` to bake one, or set ` +
              `\`agentbox config set box.daytonaClass container\` to use the container class.`,
          );
        }
        const sandbox = snapshotName
          ? await client.create({ snapshot: snapshotName, ...snapshotParams }, { timeout: 900 })
          : await client.create(
              { image: resolveImage(req.image), ...baseParams },
              {
                timeout: 900,
                ...(req.onLog ? { onSnapshotCreateLogs: req.onLog } : {}),
              },
            );
        // Record the class of the snapshot the box ACTUALLY booted from, not the
        // requested one — a user who flips `box.daytonaClass` while
        // `box.imageDaytona` still points at a snapshot of the other class would
        // otherwise have us persist a lie, and pause() would then pick the wrong
        // call. Prepared state is the only place the bake's class is written down.
        const prepared = readPreparedDaytonaState();
        const bootedClass =
          snapshotName && snapshotName === prepared?.base?.imageRef
            ? prepared.extras?.class
            : req.sandboxClass;
        return {
          sandboxId: sandbox.id,
          ...(bootedClass ? { sandboxClass: bootedClass } : {}),
        };
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

  async list(): Promise<CloudSandboxSummary[]> {
    return retry('list', async () => {
      const client = getClient();
      // `client.list()` is an AsyncIterableIterator that pages internally (it
      // was a single awaited page before SDK 0.196). It spans regions, so one
      // pass sees `us` container boxes and `us-east-1` VM boxes alike.
      const items: CloudSandboxSummary[] = [];
      for await (const sb of client.list()) {
        const summary: CloudSandboxSummary = { sandboxId: sb.id };
        const raw = sb as unknown as {
          name?: string;
          labels?: Record<string, string>;
          state?: string;
          createdAt?: string;
        };
        const friendly = raw.labels?.['agentbox.name'] ?? raw.name;
        if (friendly) summary.name = friendly;
        if (raw.createdAt) summary.createdAt = raw.createdAt;
        if (typeof raw.state === 'string') summary.state = mapState(raw.state);
        items.push(summary);
      }
      return items;
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
    // The two classes need different calls and each rejects the other's:
    //   - linux-vm: `pause()` freezes CPU + memory, so running processes and
    //     tmux sessions survive a resume. It cannot be archived
    //     ("Sandboxes in this region or class cannot be archived").
    //   - container: no pause primitive; `archive()` moves it to cold storage
    //     (filesystem only) — the historical AgentBox behavior.
    //
    // `h.sandboxClass` comes off the box record. It's absent for records written
    // before the class existed and for the keepalive loop's synthetic handles,
    // so fall back to trying both rather than guessing wrong.
    return retry(
      'pause',
      async () => {
        const sb = await getSandbox(h.sandboxId);
        // Try the recorded class first, then the other. The recorded class can
        // be wrong or absent — pre-feature records, the keepalive loop's
        // synthetic handles, and a checkpoint restored while `box.daytonaClass`
        // names the *other* class (the box's real class comes from the snapshot,
        // not from config). Whichever call is wrong is rejected outright rather
        // than doing something surprising, so trying both is safe.
        const preferVm = h.sandboxClass !== 'container';
        try {
          await (preferVm ? sb.pause() : sb.archive());
        } catch (err) {
          try {
            await (preferVm ? sb.archive() : sb.pause());
          } catch {
            throw err; // report the failure for the class we believed it was
          }
        }
      },
      { attemptTimeoutMs: 60_000 },
    );
  },

  async resume(h: CloudHandle): Promise<void> {
    // `start()` resumes both classes — a paused VM thaws (memory intact), an
    // archived container is restored from cold storage.
    return retry(
      'resume',
      async () => {
        const sb = await getSandbox(h.sandboxId);
        await sb.start();
      },
      { attemptTimeoutMs: 60_000 },
    );
  },

  /**
   * Hold off Daytona's auto-stop while the in-box agent is working.
   *
   * Daytona's timeout is an INACTIVITY window, not an absolute deadline like
   * vercel's/e2b's, so there is nothing to extend to a target time — the box
   * simply needs to look active. `refreshActivity()` resets that clock, which
   * grants another full `autoStopInterval`. So both deadline args are unused:
   * the host loop calls us precisely when it wants the box kept alive, and that
   * call is the whole signal.
   */
  async renewTimeout(h: CloudHandle): Promise<void> {
    await retry(
      'renewTimeout',
      async () => {
        const sb = await getSandbox(h.sandboxId);
        await sb.refreshActivity();
      },
      { attemptTimeoutMs: 30_000 },
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
      { attemptTimeoutMs: opts?.attemptTimeoutMs ?? 120_000, noRetry: opts?.noRetry },
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

  async createSnapshot(h: CloudHandle, snapshotName: string): Promise<void> {
    // A cold (filesystem-only) snapshot requires the sandbox STOPPED, and the
    // API does not stop it for you — a capture attempted on a running sandbox
    // is rejected. So: stop, capture, start again. The caller is responsible for
    // reconnecting the box afterwards (the stop kills ctl/dockerd/tmux) — see
    // `makeDaytonaCheckpoint`.
    //
    // The hot variant (filesystem + memory, linux-vm only) would avoid the stop
    // entirely, but it needs `includeMemory`, and the published TS SDK silently
    // drops that argument. Out of reach until upstream fixes the wrapper.
    //
    // No retry on ambiguous failures: a 504 mid-capture could leave a half-built
    // named snapshot that a retry would collide on. Matches `provision`'s policy.
    return retry(
      'createSnapshot',
      async () => {
        const sb = await getSandbox(h.sandboxId);
        await sb.stop();
        try {
          await sb._experimental_createSnapshot(snapshotName, 900);
          await waitForSnapshotActive(getClient(), snapshotName);
        } finally {
          // Always bring the box back, even if the capture failed — leaving a
          // user's box stopped because a checkpoint errored is a worse outcome
          // than the failed checkpoint itself.
          await sb.start();
        }
      },
      { attemptTimeoutMs: 900_000, retryOnAmbiguous: false },
    );
  },

  async deleteSnapshot(snapshotName: string): Promise<void> {
    return retry('deleteSnapshot', async () => {
      try {
        const client = getClient();
        const snapshot = await client.snapshot.get(snapshotName);
        await client.snapshot.delete(snapshot);
      } catch (err) {
        // Idempotent: a snapshot that's already gone is success from the
        // caller's perspective (mirrors `destroy()`'s "not found" handling).
        if (err instanceof DaytonaNotFoundError) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (/not found/i.test(msg)) return;
        throw err;
      }
    });
  },
};
