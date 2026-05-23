/**
 * `createCloudProvider(backend)` — composes a full `Provider` from a thin
 * `CloudBackend`. Every cloud backend (Daytona, future Vercel, …) reuses this
 * scaffolding instead of re-implementing workspace seeding, ctl launch, state
 * persistence, URL resolution, etc.
 *
 * v0 covers create / lifecycle / probe / exec / resolveUrl on top of the
 * `CloudBackend` primitives. The host-poller comms layer (queued git.push,
 * status event mirroring, prompts) is Phase 4 — until then a cloud box's
 * `agentbox-ctl` runs without a relay, and host-only RPCs surface a clear
 * "no relay configured" error.
 */

import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import type {
  AttachKind,
  AttachSpec,
  BoxRecord,
  BoxResourceStats,
  BoxRuntimeState,
  BuildAttachOptions,
  CloudBackend,
  CloudHandle,
  CreateBoxRequest,
  CreatedBox,
  ExecOptions,
  ExecResult,
  InspectedBox,
  Provider,
  ProviderCheckpoint,
} from '@agentbox/core';
import { allocateProjectIndex, readState, recordBox, removeBoxRecord } from '@agentbox/sandbox-core';
import {
  ensureRelay,
  forgetBoxFromRelay,
  generateRelayToken,
  generateVncPassword,
  registerBoxWithRelay,
} from '@agentbox/sandbox-docker';
import {
  ensureAgentVolumesForCloud,
  seedAgentVolumesIfFresh,
} from './agent-credentials.js';
import {
  cloudSnapshotName,
  listCloudCheckpoints,
  removeCloudCheckpointDir,
  resolveCloudCheckpoint,
  writeCloudCheckpointManifest,
} from './checkpoint.js';
import { uploadEnvFiles } from './env-files.js';
import {
  downloadFromCloudBox,
  pullCloudDirContents,
  uploadToCloudBox,
} from './cloud-cp.js';
import { launchCloudCtlDaemon } from './ctl-launch.js';
import { quoteShellArgv } from './shell.js';
import { launchCloudVncDaemon } from './vnc-launch.js';
import { seedCloudWorkspace } from './workspace-seed.js';

/** Workspace mount path inside every cloud sandbox. Matches the Docker model. */
export const CLOUD_WORKSPACE_DIR = '/workspace';
/** In-box port the supervisor's WebProxy binds to. Non-privileged so no `setcap` dep. */
export const CLOUD_WEB_PROXY_PORT = 8080;
/** In-box port the noVNC viewer (websockify) serves on — fixed by Dockerfile.box. */
export const CLOUD_VNC_PORT = 6080;
/**
 * Default expiry for browser-bound signed preview URLs. 1h matches Daytona's
 * docs recommendation: long enough for one CLI invocation + browser session,
 * short enough that a stale link doesn't outlive the box. Override with the
 * CLI `--ttl` flag when sharing or running long-lived sessions.
 */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 3600;

/**
 * Provider-neutral image selector. Cloud backends typically resolve it to a
 * snapshot ref (Daytona) or a registry image. Backends may translate it via
 * `provisionImage` (see `CreateCloudProviderOptions`).
 */
export interface CreateCloudProviderOptions {
  /**
   * Translate the request's image to a backend-specific image / snapshot ref.
   * When omitted the backend is handed `req.image` verbatim (or the v0 default
   * `agentbox/box:dev`, which most cloud backends won't be able to resolve —
   * Daytona uses its snapshot helper here).
   */
  provisionImage?(req: CreateBoxRequest): Promise<string>;
  /**
   * Per-create cloud resource ceiling. Default: 2 cpu / 4 GiB / 8 GiB disk.
   */
  defaultResources?: { cpu?: number; memory?: number; disk?: number };
}

const FALLBACK_IMAGE = 'agentbox/box:dev';

export function createCloudProvider(
  backend: CloudBackend,
  opts: CreateCloudProviderOptions = {},
): Provider {
  const providerName = backend.name;

  function handleFor(box: BoxRecord): CloudHandle {
    const sandboxId = box.cloud?.sandboxId;
    if (!sandboxId) {
      throw new Error(`cloud box ${box.name} has no sandboxId — record is malformed`);
    }
    return { sandboxId };
  }

  /** Resolve a fresh per-cloud-box id + name + branch + synthetic container ref. */
  function mintBox(req: CreateBoxRequest): {
    id: string;
    name: string;
    branch: string;
    container: string;
  } {
    const id = randomBytes(4).toString('hex');
    const name = req.name ?? `${basename(req.workspacePath)}-${id}`;
    return {
      id,
      name,
      branch: `agentbox/${name}`,
      // BoxRecord.container is required (Docker legacy); use a synthetic value
      // that never resolves to a real Docker container.
      container: `agentbox-cloud-${id}`,
    };
  }

  async function probe(box: BoxRecord): Promise<BoxRuntimeState> {
    try {
      const h = handleFor(box);
      const state = await backend.state(h);
      // CloudState aligns with BoxRuntimeState by construction.
      return state;
    } catch {
      return 'missing';
    }
  }

  return {
    name: providerName,

    async create(req: CreateBoxRequest): Promise<CreatedBox> {
      const log = req.onLog ?? (() => {});
      const { id, name, branch, container } = mintBox(req);
      const image = opts.provisionImage ? await opts.provisionImage(req) : (req.image ?? FALLBACK_IMAGE);
      const resources = opts.defaultResources ?? { cpu: 2, memory: 4, disk: 8 };

      // Per-box tokens: `relayToken` authenticates the in-box agent to its
      // in-sandbox relay (`/events`, `/rpc` bearer); `bridgeToken` separately
      // authenticates the HOST poller to the in-sandbox relay's `/bridge/*`
      // routes. Distinct so a compromised agent can't impersonate the host.
      const relayToken = generateRelayToken();
      const bridgeToken = generateRelayToken();

      // Bring the host relay up before we provision — registering the box
      // (and starting its CloudBoxPoller) happens at the bottom of this
      // function, and the loop wants the host relay reachable.
      try {
        await ensureRelay({ onLog: log });
      } catch (err) {
        log(`relay ensure failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
      }

      // Resolve any cloud checkpoint the caller requested. When found, we
      // boot from the snapshot (which already carries /workspace + any
      // installed deps) instead of from the base image, and skip the
      // workspace-seeding step below. A `checkpointRef` set for a checkpoint
      // that doesn't exist for THIS backend is logged and silently dropped —
      // matches the wizard's provider-aware behavior (the user may have a
      // Docker checkpoint with the same name; that's not our store).
      let snapshotName: string | undefined;
      let resolvedCheckpointRef: string | undefined;
      if (req.checkpointRef && req.projectRoot) {
        const found = await resolveCloudCheckpoint(req.projectRoot, backend.name, req.checkpointRef);
        if (found) {
          snapshotName = found.manifest.snapshotName;
          resolvedCheckpointRef = found.name;
          log(`provisioning from cloud checkpoint '${found.name}' (snapshot ${snapshotName})`);
        } else {
          log(
            `cloud checkpoint '${req.checkpointRef}' not found for ${backend.name}; provisioning from base image`,
          );
        }
      }

      // Reserve per-agent credential volumes (Claude / Codex / OpenCode)
      // before provision so we can pass them as mounts in the same SDK call —
      // Daytona only attaches volumes at create time, not after. Backends
      // without a volume primitive return an empty list and we degrade to
      // "user logs in inside the box" the way cloud worked before.
      const agentVolumes = await ensureAgentVolumesForCloud(backend, { onLog: log });

      log(
        snapshotName
          ? `provisioning ${providerName} sandbox from snapshot`
          : `provisioning ${providerName} sandbox`,
      );
      const handle = await backend.provision({
        name,
        image,
        snapshot: snapshotName,
        resources,
        env: {
          AGENTBOX_BOX_ID: id,
          AGENTBOX_BOX_NAME: name,
          AGENTBOX_BOX_KIND: 'cloud',
          // In-sandbox relay is on the box's loopback at the default port.
          AGENTBOX_RELAY_URL: `http://127.0.0.1:${String(8787)}`,
          AGENTBOX_RELAY_TOKEN: relayToken,
          AGENTBOX_BRIDGE_TOKEN: bridgeToken,
          ...agentVolumes.env,
        },
        volumes: agentVolumes.mounts,
        onLog: log,
      });

      try {
        if (snapshotName) {
          // Snapshot already carries /workspace (captured by the source box's
          // `agentbox checkpoint create`). Re-seeding would clobber the
          // user's setup state. Match Docker's `applyCheckpointRef` behavior.
          log('skipping workspace seed — snapshot already contains /workspace');
        } else {
          await seedCloudWorkspace({
            backend,
            handle,
            workspacePath: req.workspacePath,
            branch,
            workspaceDir: CLOUD_WORKSPACE_DIR,
            onLog: log,
          });
        }

        // After the sandbox is up with the credential volumes mounted, seed
        // any volume that doesn't already carry a `.agentbox-seeded-at`
        // marker from the host's filtered ~/.claude / ~/.codex /
        // opencode tree. Idempotent per agent — subsequent boxes find the
        // marker and skip the upload entirely.
        if (agentVolumes.agents.length > 0) {
          await seedAgentVolumesIfFresh(backend, handle, {
            agents: agentVolumes.agents,
            hostWorkspace: req.workspacePath,
            onLog: log,
          });
        }

        // Copy the env/config files the setup wizard collected (`.env`,
        // `secrets.toml`, `agentbox.yaml`, …) into `/workspace`. The Docker
        // provider does the same via copyHostEnvFilesToBox; before this hook
        // these files were silently dropped on the cloud path.
        if (req.envFilesToImport && req.envFilesToImport.length > 0) {
          const { copied } = await uploadEnvFiles({
            backend,
            handle,
            workspacePath: req.workspacePath,
            files: req.envFilesToImport,
            workspaceDir: CLOUD_WORKSPACE_DIR,
            onLog: log,
          });
          if (copied > 0) log(`copied ${String(copied)} env/config file(s) into /workspace`);
        }

        log('launching agentbox-ctl daemon');
        await launchCloudCtlDaemon({
          backend,
          handle,
          boxId: id,
          boxName: name,
          relayUrl: `http://127.0.0.1:${String(8787)}`,
          relayToken,
          bridgeToken,
        });

        // Mint the per-box VNC password and start the in-sandbox VNC stack
        // when VNC is opted in (default-on, matching Docker). Best-effort —
        // a failure logs but doesn't fail create; `agentbox screen` will
        // surface "daemon may not be up" if the URL stays 502.
        const vncEnabled = req.vnc?.enabled !== false;
        const vncPassword = vncEnabled ? generateVncPassword() : undefined;
        if (vncEnabled && vncPassword) {
          log('launching VNC stack (Xvnc + websockify + noVNC)');
          try {
            await launchCloudVncDaemon({ backend, handle, vncPassword });
          } catch (err) {
            log(
              `VNC daemon launch failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // The web preview URL is best-effort at create — most boxes won't
        // have a service on CLOUD_WEB_PROXY_PORT until the supervisor schedules
        // the `expose:` service. `agentbox url` re-resolves on demand.
        let webPreview: { url: string; token?: string } | undefined;
        try {
          webPreview = await backend.previewUrl(handle, CLOUD_WEB_PROXY_PORT);
        } catch {
          webPreview = undefined;
        }

        // The bridge preview URL is critical: it's how the host CloudBoxPoller
        // reaches the in-sandbox relay. The ctl daemon binds 0.0.0.0:8787 in
        // box mode (cloud), so the Daytona preview proxy can route to it.
        let relayPreview: { url: string; token?: string } | undefined;
        try {
          relayPreview = await backend.previewUrl(handle, 8787);
        } catch {
          relayPreview = undefined;
        }

        // Tell the host relay about this cloud box so it spawns a poller.
        // Best-effort: a failed register doesn't break create (status / git
        // push just won't reach the host until a later register).
        if (relayPreview) {
          try {
            await registerBoxWithRelay({
              boxId: id,
              token: relayToken,
              name,
              kind: 'cloud',
              backend: backend.name,
              previewUrl: relayPreview.url,
              previewToken: relayPreview.token,
              bridgeToken,
              createdAt: new Date().toISOString(),
            });
          } catch (err) {
            log(
              `register with host relay failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        const state = await readState();
        const projectIndex = req.projectRoot
          ? allocateProjectIndex(state, req.projectRoot)
          : undefined;

        const record: BoxRecord = {
          id,
          name,
          provider: providerName,
          container,
          image,
          workspacePath: req.workspacePath,
          projectRoot: req.projectRoot,
          projectIndex,
          relayToken,
          withPlaywright: req.withPlaywright,
          withEnv: req.withEnv,
          vncEnabled,
          vncPassword,
          vncContainerPort: vncEnabled ? CLOUD_VNC_PORT : undefined,
          resourceLimits: req.limits
            ? {
                memoryBytes: req.limits.memoryBytes ?? undefined,
                cpus: req.limits.cpus ?? undefined,
                pidsLimit: req.limits.pidsLimit ?? undefined,
                disk: req.limits.disk ?? undefined,
              }
            : undefined,
          cloud: {
            backend: backend.name,
            sandboxId: handle.sandboxId,
            image,
            webPort: CLOUD_WEB_PROXY_PORT,
            previewUrls: webPreview ? { [CLOUD_WEB_PROXY_PORT]: webPreview.url } : undefined,
            relayPreviewUrl: relayPreview?.url,
            relayPreviewToken: relayPreview?.token,
            bridgeToken,
            snapshotRef: resolvedCheckpointRef,
          },
          createdAt: new Date().toISOString(),
        };
        await recordBox(record);
        return { record, imageBuilt: false };
      } catch (err) {
        // Best-effort teardown of the half-provisioned sandbox so a failed
        // create doesn't leave the user paying for an inert box.
        try {
          await backend.destroy(handle);
        } catch {
          // The user is going to see the original error; suppressing this
          // secondary failure keeps the message clean.
        }
        throw err;
      }
    },

    async start(box: BoxRecord): Promise<BoxRecord> {
      const h = handleFor(box);
      await backend.start(h);
      // Preview URLs (and their tokens) can rotate across stop/start — refresh
      // the web + relay preview URLs and persist so `agentbox url` and the
      // host poller see the live values.
      const webPort = box.cloud?.webPort ?? CLOUD_WEB_PROXY_PORT;
      let webPreview: { url: string; token?: string } | undefined;
      try {
        webPreview = await backend.previewUrl(h, webPort);
      } catch {
        const cached = box.cloud?.previewUrls?.[webPort];
        webPreview = cached ? { url: cached } : undefined;
      }
      let relayPreview: { url: string; token?: string } | undefined;
      try {
        relayPreview = await backend.previewUrl(h, 8787);
      } catch {
        relayPreview = box.cloud?.relayPreviewUrl
          ? { url: box.cloud.relayPreviewUrl, token: box.cloud.relayPreviewToken }
          : undefined;
      }
      const next: BoxRecord = {
        ...box,
        cloud: {
          ...(box.cloud ?? { backend: providerName, sandboxId: h.sandboxId }),
          webPort,
          previewUrls:
            webPreview !== undefined
              ? { ...(box.cloud?.previewUrls ?? {}), [webPort]: webPreview.url }
              : box.cloud?.previewUrls,
          relayPreviewUrl: relayPreview?.url ?? box.cloud?.relayPreviewUrl,
          relayPreviewToken: relayPreview?.token ?? box.cloud?.relayPreviewToken,
        },
      };
      await recordBox(next);
      // Re-launch the ctl daemon — it dies with the sandbox.
      await launchCloudCtlDaemon({
        backend,
        handle: h,
        boxId: box.id,
        boxName: box.name,
        relayUrl: `http://127.0.0.1:${String(8787)}`,
        relayToken: box.relayToken ?? '',
        bridgeToken: box.cloud?.bridgeToken,
      });
      // Re-launch the VNC stack — Xvnc + websockify die with the sandbox.
      // Best-effort: a failure here shouldn't block start; `agentbox screen`
      // surfaces the missing daemon with a clear error.
      if (box.vncEnabled && box.vncPassword) {
        try {
          await launchCloudVncDaemon({ backend, handle: h, vncPassword: box.vncPassword });
        } catch {
          // swallowed; user-visible error comes from `agentbox screen` if it
          // can't reach websockify after a few retries.
        }
      }
      // Re-register with the host relay so its CloudBoxPoller picks up the
      // fresh preview URL/token.
      if (relayPreview && box.relayToken && box.cloud?.bridgeToken) {
        try {
          await registerBoxWithRelay({
            boxId: box.id,
            token: box.relayToken,
            name: box.name,
            kind: 'cloud',
            backend: backend.name,
            previewUrl: relayPreview.url,
            previewToken: relayPreview.token,
            bridgeToken: box.cloud.bridgeToken,
            createdAt: box.createdAt,
            projectIndex: box.projectIndex,
          });
        } catch {
          // best-effort
        }
      }
      return next;
    },

    async pause(box: BoxRecord): Promise<void> {
      await backend.pause(handleFor(box));
    },

    async resume(box: BoxRecord): Promise<void> {
      await backend.resume(handleFor(box));
    },

    async stop(box: BoxRecord): Promise<void> {
      await backend.stop(handleFor(box));
    },

    async destroy(box: BoxRecord): Promise<void> {
      try {
        await backend.destroy(handleFor(box));
      } catch (err) {
        // Surface but don't block state cleanup — a "missing" sandbox should
        // still let `agentbox destroy` drop the local record.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/not.?found|missing/i.test(msg)) throw err;
      }
      // Best-effort: stop the host poller and drop the registration.
      try {
        await forgetBoxFromRelay(box.id);
      } catch {
        // forgetBoxFromRelay already swallows; this catch is paranoid.
      }
      await removeBoxRecord(box.id);
    },

    async probeState(box: BoxRecord): Promise<BoxRuntimeState> {
      return probe(box);
    },

    async inspect(box: BoxRecord): Promise<InspectedBox> {
      const state = await probe(box);
      const webPort = box.cloud?.webPort ?? CLOUD_WEB_PROXY_PORT;
      const webUrl = box.cloud?.previewUrls?.[webPort];
      return {
        record: box,
        state,
        endpoints: {
          domain: box.cloud?.previewUrls?.[webPort] ? new URL(box.cloud.previewUrls[webPort]!).host : '',
          domainIsOrb: false,
          endpoints: webUrl
            ? [{ kind: 'web', name: 'web', containerPort: webPort, url: webUrl, reachable: true }]
            : [],
        },
        raw: undefined,
      };
    },

    async exec(box: BoxRecord, argv: string[], opts?: ExecOptions): Promise<ExecResult> {
      const r = await backend.exec(handleFor(box), quoteShellArgv(argv), {
        cwd: opts?.cwd,
        env: opts?.env,
        user: opts?.user,
      });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    },

    async buildAttach(
      box: BoxRecord,
      kind: AttachKind,
      opts?: BuildAttachOptions,
    ): Promise<AttachSpec> {
      if (!backend.attachArgv) {
        throw new Error(
          `cloud backend '${backend.name}' does not implement attachArgv — interactive attach not supported`,
        );
      }
      const handle = handleFor(box);
      const baseArgv = await backend.attachArgv(handle);
      const inner = renderInnerCommand(kind, opts);
      // -t forces TTY allocation on the remote side (the SSH default of
      // skipping TTY when a command is provided would break tmux + readline).
      const argv = [...baseArgv.slice(1), '-t', inner];
      // Keep argv[0] = the program name (ssh) so callers can split.
      const fullArgv = [baseArgv[0]!, ...argv];
      const cleanup = backend.revokeAttachToken
        ? async (): Promise<void> => {
            await backend.revokeAttachToken!(handle, baseArgv);
          }
        : undefined;
      return { argv: fullArgv, cleanup };
    },

    async uploadPath(
      box: BoxRecord,
      hostSrc: string,
      boxDst: string,
    ): Promise<{ finalPath: string }> {
      return uploadToCloudBox(backend, handleFor(box), hostSrc, boxDst);
    },

    async downloadPath(
      box: BoxRecord,
      boxSrc: string,
      hostDst: string,
    ): Promise<{ finalPath: string }> {
      return downloadFromCloudBox(backend, handleFor(box), boxSrc, hostDst);
    },

    async downloadDirContents(
      box: BoxRecord,
      boxSrc: string,
      hostDst: string,
    ): Promise<{ finalPath: string }> {
      return pullCloudDirContents(backend, handleFor(box), boxSrc, hostDst);
    },

    async resolveUrl(
      box: BoxRecord,
      opts?: { loopback?: boolean; kind?: 'web' | 'vnc'; ttl?: number },
    ): Promise<string> {
      const h = handleFor(box);
      const kind = opts?.kind ?? 'web';
      // VNC port is fixed by Dockerfile.box (websockify serves noVNC on :6080).
      const port = kind === 'vnc' ? CLOUD_VNC_PORT : (box.cloud?.webPort ?? CLOUD_WEB_PROXY_PORT);
      // Always re-resolve through the SDK — cached URLs on the record may be
      // from a previous start whose token has rotated. Prefer signed URLs
      // because the user is about to hand the URL to a browser (no way to
      // attach an `x-daytona-preview-token` header from a click).
      if (backend.signedPreviewUrl) {
        const ttl = opts?.ttl ?? DEFAULT_SIGNED_URL_TTL_SECONDS;
        const signed = await backend.signedPreviewUrl(h, port, ttl);
        return signed.url;
      }
      // No signed-URL primitive: fall back to the header-token URL, but fail
      // loudly so the caller sees this isn't usable in a browser as-is.
      const p = await backend.previewUrl(h, port);
      throw new Error(
        `cloud backend '${backend.name}' does not support signed preview URLs; ` +
          `the standard URL (${p.url}) requires a header token (e.g. x-daytona-preview-token: ${p.token ?? '<unset>'}) ` +
          `that browsers can't attach from a click. Use a programmatic client or wait for backend support.`,
      );
    },

    // Cloud checkpoint capability. Backends without `createSnapshot` get a
    // capability stub whose methods throw — the CLI's `agentbox checkpoint
    // create` then surfaces a clean "not supported" error rather than a
    // silent no-op.
    checkpoint: makeCloudCheckpoint(backend),

    // stats is provider-optional; cloud backends without a metrics API just
    // omit it. Backends that have one can decorate the returned provider.
  };
}

/**
 * Build the `Provider.checkpoint` capability for a cloud backend.
 *
 * - `create(box, name)` captures the live sandbox via `backend.createSnapshot`
 *   and persists a thin manifest on the host (`~/.agentbox/cloud-checkpoints/…`).
 * - `list(projectRoot)` reads the on-disk manifest store.
 * - `remove(projectRoot, ref)` deletes the Daytona snapshot best-effort and
 *   removes the local manifest unconditionally so a remote-only failure
 *   doesn't leave the user with a dead pointer.
 */
function makeCloudCheckpoint(backend: CloudBackend): ProviderCheckpoint {
  return {
    async create(box: BoxRecord, name: string) {
      if (!backend.createSnapshot) {
        throw new Error(
          `cloud backend '${backend.name}' doesn't support snapshots — \`agentbox checkpoint\` unavailable`,
        );
      }
      if (!box.projectRoot) {
        throw new Error(
          `cloud checkpoint requires the box to have a project root (run \`agentbox checkpoint\` from inside the project)`,
        );
      }
      if (!box.cloud?.sandboxId) {
        throw new Error(`cloud box ${box.name} has no sandboxId — record is malformed`);
      }
      const snapshotName = cloudSnapshotName(box.projectRoot, name);
      await backend.createSnapshot({ sandboxId: box.cloud.sandboxId }, snapshotName);
      const info = await writeCloudCheckpointManifest(box.projectRoot, backend.name, name, {
        snapshotName,
        sourceBoxId: box.id,
        sourceBoxName: box.name,
      });
      return { ref: info.name };
    },
    async list(projectRoot: string) {
      const entries = await listCloudCheckpoints(projectRoot, backend.name);
      return entries.map((e) => ({ ref: e.name, createdAt: e.manifest.createdAt }));
    },
    async remove(projectRoot: string, ref: string) {
      const entry = await resolveCloudCheckpoint(projectRoot, backend.name, ref);
      if (!entry) return;
      if (backend.deleteSnapshot) {
        try {
          await backend.deleteSnapshot(entry.manifest.snapshotName);
        } catch {
          // Best-effort: even if the remote delete fails (network, perms,
          // or already-gone), drop the local manifest so the user isn't
          // stuck with a pointer to nothing. They can clean up the orphan
          // snapshot from the Daytona dashboard.
        }
      }
      await removeCloudCheckpointDir(projectRoot, backend.name, ref);
    },
  };
}

/**
 * Build the inner shell command tmux runs inside the cloud sandbox for an
 * attach. The string is later embedded in `ssh ... -t '<cmd>'`, so it must
 * be a single shell-safe phrase (the SSH client passes it to the remote
 * `sshd` which feeds it to the user's login shell).
 *
 * `tmux new-session -A` attaches if a session with the given name exists,
 * otherwise creates a fresh one running the fallback command. Matches the
 * Docker shell command's tmux semantics so the UX feels the same.
 */
function renderInnerCommand(kind: AttachKind, opts?: BuildAttachOptions): string {
  const sessionName = opts?.sessionName ?? defaultSessionName(kind);
  const fallback = opts?.command ?? defaultCommand(kind, opts);
  if (kind === 'logs') {
    // logs always tails; tmux makes no sense here.
    return fallback;
  }
  if (opts?.noTmux) {
    return fallback;
  }
  // Single-quote the inner cmd so tmux gets exactly one argv element. Use
  // `command -v tmux` so a missing tmux fails fast with a clear error.
  return `command -v tmux >/dev/null || { echo "tmux not installed in sandbox"; exit 127; }; exec tmux new-session -A -s ${shellSingle(sessionName)} ${shellSingle(fallback)}`;
}

function defaultSessionName(kind: AttachKind): string {
  switch (kind) {
    case 'shell':
      return 'shell';
    case 'agent':
      return 'agent';
    case 'logs':
      return 'logs';
  }
}

function defaultCommand(kind: AttachKind, opts?: BuildAttachOptions): string {
  switch (kind) {
    case 'shell':
      return 'bash -l';
    case 'agent':
      // Caller didn't tell us which agent — fall back to a login shell;
      // claude/codex/opencode wrappers pass an explicit `command`.
      return 'bash -l';
    case 'logs':
      // Caller MUST pass service + a real command for logs; this is a safe
      // placeholder when neither is set.
      return opts?.service
        ? `tail -F ${opts.follow !== false ? '' : '-n 0 '}/var/log/agentbox/${opts.service}.log`
        : 'echo "no service specified — set BuildAttachOptions.service"';
  }
}

/** Wrap an arbitrary string in single quotes for embedding in a shell command. */
function shellSingle(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Helper: returns a BoxResourceStats stub so callers needn't unwrap optional. */
export function emptyCloudStats(provider: string): BoxResourceStats {
  return {
    source: provider,
    live: false,
    cpuPercent: null,
    memUsedBytes: null,
    memLimitBytes: null,
    memPercent: null,
    pids: null,
    diskUsedBytes: null,
    snapshotDiskBytes: null,
    checkpointVolumeBytes: null,
    netRxBytes: null,
    netTxBytes: null,
    blockReadBytes: null,
    blockWriteBytes: null,
    limits: { memoryBytes: null, cpus: null, pidsLimit: null, disk: null },
    warnings: [],
  };
}
