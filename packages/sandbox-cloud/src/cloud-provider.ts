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
  buildTmuxConfigShellSnippet,
  ensureRelay,
  forgetBoxFromRelay,
  generateRelayToken,
  generateVncPassword,
  portlessAlias,
  portlessGetUrl,
  portlessUnalias,
  registerBoxWithRelay,
} from '@agentbox/sandbox-docker';
import {
  ensureAgentVolumesForCloud,
  seedAgentVolumesIfFresh,
  seedOpencodeModelState,
} from './agent-credentials.js';
import {
  cloudSnapshotName,
  listCloudCheckpoints,
  removeCloudCheckpointDir,
  resolveCloudCheckpoint,
  writeCloudCheckpointManifest,
} from './checkpoint.js';
import { uploadEnvFiles } from './env-files.js';
import { uploadCarryPaths } from './carry.js';
import { readExposedServicePorts } from './expose-ports.js';
import {
  downloadFromCloudBox,
  pullCloudDirContents,
  uploadToCloudBox,
} from './cloud-cp.js';
import { launchCloudCtlDaemon } from './ctl-launch.js';
import { launchCloudDockerdDaemon } from './dockerd-launch.js';
import { quoteShellArgv } from './shell.js';
import { launchCloudVncDaemon } from './vnc-launch.js';
import { seedCloudWorkspace } from './workspace-seed.js';

/** Workspace mount path inside every cloud sandbox. Matches the Docker model. */
export const CLOUD_WORKSPACE_DIR = '/workspace';
/**
 * In-box port the supervisor's WebProxy binds to. Matches `RESERVED_WEB_PORT`
 * in `@agentbox/ctl` (the only container port AgentBox publishes) — node has
 * `cap_net_bind_service` set in both the Docker and Hetzner base images so the
 * bind to <1024 needs no root. Daytona's base image inherits the same setcap
 * via Dockerfile.box.
 */
export const CLOUD_WEB_PROXY_PORT = 80;
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
  /**
   * Whether to launch the in-box `dockerd` daemon on create/start. Default
   * true (Daytona/Hetzner support nested containers). Vercel Sandbox blocks the
   * namespace syscalls a container runtime needs, so its provider sets this
   * false — otherwise every create/start logs a spurious dockerd failure.
   */
  launchDockerd?: boolean;
}

const FALLBACK_IMAGE = 'agentbox/box:dev';

/** Default Portless no-TLS proxy port — matches the host wizard's choice. */
const DEFAULT_PORTLESS_PROXY_PORT = 1355;

/**
 * Parse a host portless preview URL like `http://my-box.localhost:1355` /
 * `https://my-box.localhost` into the proxy mode the in-VPS mirror should
 * match. Returns `undefined` when the URL isn't a `*.localhost` portless URL
 * (e.g. portless isn't installed and we fell back to a loopback URL).
 */
function parsePortlessUrl(url: string): { proxyPort: number; tls: boolean } | undefined {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('.localhost')) return undefined;
    const tls = u.protocol === 'https:';
    const proxyPort = u.port
      ? Number.parseInt(u.port, 10)
      : tls
        ? 443
        : 80;
    if (!Number.isFinite(proxyPort)) return undefined;
    return { proxyPort, tls };
  } catch {
    return undefined;
  }
}

/**
 * Parse a loopback `http://127.0.0.1:<N>` URL into its port. Returns
 * `undefined` for any non-loopback URL (Daytona-style public URLs naturally
 * skip the Portless alias path).
 */
function parseLoopbackPort(url: string): number | undefined {
  try {
    const u = new URL(url);
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return undefined;
    const port = Number.parseInt(u.port, 10);
    return Number.isFinite(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Register a single host Portless alias `<alias>.localhost -> <previewUrl>`
 * when `previewUrl` resolves to a loopback `http://127.0.0.1:<port>` (Hetzner's
 * `ssh -L` forward). For backends that return a public URL (Daytona's signed
 * preview) the alias is naturally skipped. Best-effort: every Portless call
 * already swallows; we never throw from here. Returns the resolved URL on
 * success.
 */
async function registerHostPortlessAlias(args: {
  alias: string;
  previewUrl: string;
  label: string;
  onLog: (line: string) => void;
}): Promise<string | undefined> {
  const localPort = parseLoopbackPort(args.previewUrl);
  if (localPort === undefined) return undefined;
  const ok = await portlessAlias(args.alias, localPort);
  if (!ok) {
    args.onLog(
      `portless: ${args.label} alias not registered (portless CLI missing or not running) — host URL stays http://127.0.0.1:${String(localPort)}`,
    );
    return undefined;
  }
  const url = await portlessGetUrl(args.alias);
  args.onLog(`portless alias ${url} -> 127.0.0.1:${String(localPort)}`);
  return url;
}

/**
 * Register the host Portless alias for `<boxName>.localhost -> <webPreviewUrl>`
 * and bring up the in-VPS mirror proxy so the same URL works from inside the
 * box. Best-effort: every step is gated on a previous step's success, and any
 * failure logs but doesn't throw. Returns `{ alias, url }` when the host alias
 * landed (so the caller can persist it on the BoxRecord), `undefined` otherwise.
 */
async function bootstrapPortlessForCloudBox(
  backend: CloudBackend,
  handle: CloudHandle,
  args: { boxName: string; webPreviewUrl: string; webPort: number; onLog: (line: string) => void },
): Promise<{ alias: string; url: string } | undefined> {
  const url = await registerHostPortlessAlias({
    alias: args.boxName,
    previewUrl: args.webPreviewUrl,
    label: 'web',
    onLog: args.onLog,
  });
  if (!url) return undefined;
  if (backend.startInBoxPortless) {
    const mode = parsePortlessUrl(url) ?? { proxyPort: DEFAULT_PORTLESS_PROXY_PORT, tls: false };
    try {
      await backend.startInBoxPortless(handle, {
        boxName: args.boxName,
        proxyPort: mode.proxyPort,
        tls: mode.tls,
        webPort: args.webPort,
      });
      args.onLog(
        `portless: in-box mirror up on 127.0.0.1:${String(mode.proxyPort)} (${mode.tls ? 'https' : 'http'})`,
      );
    } catch (err) {
      args.onLog(
        `portless: in-box mirror failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { alias: args.boxName, url };
}

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

  /** Resolve a fresh per-cloud-box id + name + branch. */
  function mintBox(req: CreateBoxRequest): {
    id: string;
    name: string;
    branch: string;
  } {
    const id = randomBytes(4).toString('hex');
    const name = req.name ?? `${basename(req.workspacePath)}-${id}`;
    return {
      id,
      name,
      // --use-branch reuses the named branch directly; otherwise fork a fresh
      // per-box branch. The CLI validated `useBranch` exists host-side.
      branch: req.useBranch ?? `agentbox/${name}`,
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
      const { id, name, branch } = mintBox(req);
      const image = opts.provisionImage ? await opts.provisionImage(req) : (req.image ?? FALLBACK_IMAGE);
      // Per-create overrides (currently vercel's box.vercelVcpus / vercelTimeoutMs,
      // threaded through providerOptions). Fall back to the provider's static
      // defaults so daytona/hetzner are unaffected.
      const baseResources = opts.defaultResources ?? { cpu: 2, memory: 4, disk: 8 };
      const vcpuOverride = req.providerOptions?.['vcpus'];
      const resources =
        typeof vcpuOverride === 'number' && vcpuOverride > 0
          ? { ...baseResources, cpu: vcpuOverride }
          : baseResources;
      const timeoutOverride = req.providerOptions?.['timeoutMs'];
      const timeoutMs =
        typeof timeoutOverride === 'number' && timeoutOverride > 0 ? timeoutOverride : undefined;
      const networkPolicyOpt = req.providerOptions?.['networkPolicy'];
      const networkPolicy =
        typeof networkPolicyOpt === 'string' && networkPolicyOpt.trim() !== ''
          ? networkPolicyOpt.trim()
          : undefined;

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

      // Read the `expose:` service ports up front so port-capped backends
      // (vercel) can declare them at create time — a preview URL only routes to
      // a port that was exposed when the sandbox was created. Reused below for
      // the per-service preview-URL map. Best-effort: [] when there's no yaml.
      const exposeServicePorts = await readExposedServicePorts(req.workspacePath);

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
        timeoutMs,
        exposePorts: exposeServicePorts,
        networkPolicy,
        env: {
          AGENTBOX_BOX_ID: id,
          AGENTBOX_BOX_NAME: name,
          AGENTBOX_BOX_KIND: 'cloud',
          // In-sandbox relay is on the box's loopback at the in-box port.
          // 8788 is distinct from the host relay's 8787 so a nested agentbox
          // run inside the box can claim :8787 without colliding.
          AGENTBOX_RELAY_URL: `http://127.0.0.1:${String(8788)}`,
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
            bundleDepth: req.bundleDepth,
            fromBranch: req.fromBranch,
            useBranch: req.useBranch,
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

        // Seed the host's selected OpenCode model into the box's (ephemeral)
        // state dir on every create. Runs unconditionally — Hetzner has no
        // credentials volume, so it is absent from `agentVolumes.agents` above
        // yet still needs the model seeded.
        await seedOpencodeModelState(backend, handle, { onLog: log });

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

        // carry: from agentbox.yaml — runs after the env-file copies and
        // before the supervisor launches, mirroring the docker provider.
        // The host CLI already resolved + got user approval before threading
        // entries into req.carry.
        let carrySummary: { count: number; entries: Array<{ src: string; dest: string; bytes: number }> } | undefined;
        if (req.carry && req.carry.length > 0) {
          log(`carry: copying ${String(req.carry.length)} host path(s) into the box`);
          const result = await uploadCarryPaths({
            backend,
            handle,
            entries: req.carry,
            onLog: log,
          });
          log(`carry: copied ${String(result.copied)}/${String(req.carry.length)} entry/entries`);
          for (const err of result.errors) log(`carry: ${err}`);
          if (result.applied.length > 0) {
            carrySummary = { count: result.applied.length, entries: result.applied };
          }
        }

        log('launching agentbox-ctl daemon');
        await launchCloudCtlDaemon({
          backend,
          handle,
          boxId: id,
          boxName: name,
          relayUrl: `http://127.0.0.1:${String(8788)}`,
          relayToken,
          bridgeToken,
        });

        // Always-on in-box dockerd, matching the Docker provider
        // (packages/sandbox-docker/src/create.ts:788). The image already bakes
        // /usr/local/bin/agentbox-dockerd-start; Daytona sandboxes ship with
        // CAP_SYS_ADMIN so it starts cleanly. Best-effort — a slow or failed
        // start shouldn't fail create; `agentbox start` re-launches it on
        // resume because dockerd dies with the sandbox. Skipped for backends
        // that can't run nested containers (vercel), which set launchDockerd:false.
        if (opts.launchDockerd !== false) {
          log('launching in-box dockerd');
          try {
            const dockerd = await launchCloudDockerdDaemon({ backend, handle, timeoutMs: 60_000 });
            if (!dockerd.up) log(`dockerd did not become ready (continuing): ${dockerd.reason ?? 'unknown'}`);
          } catch (err) {
            log(`dockerd daemon launch failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
          }
        }

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

        // Portless host alias + in-VPS mirror. Default-on for backends whose
        // `previewUrl()` returns a loopback URL (Hetzner); naturally skipped
        // for public-URL backends (Daytona) because the URL doesn't parse as
        // 127.0.0.1. Caller can opt out via `providerOptions.portless: false`.
        // Best-effort: every step logs + continues on failure.
        const portlessOpt = (req.providerOptions?.['portless'] as boolean | undefined) ?? true;
        let portlessAliasName: string | undefined;
        let portlessUrlResolved: string | undefined;
        if (portlessOpt && webPreview) {
          const r = await bootstrapPortlessForCloudBox(backend, handle, {
            boxName: name,
            webPreviewUrl: webPreview.url,
            webPort: CLOUD_WEB_PROXY_PORT,
            onLog: log,
          });
          if (r) {
            portlessAliasName = r.alias;
            portlessUrlResolved = r.url;
          }
        }
        // Parallel `vnc-<box-name>.localhost` alias against the in-box noVNC
        // port. Host-only — no in-box mirror; an agent inside the box opening
        // its own VNC view is a degenerate self-loop. Same loopback-URL gate
        // as the web path, so Daytona naturally skips and Hetzner registers.
        let vncPreview: { url: string; token?: string } | undefined;
        if (portlessOpt && vncEnabled) {
          try {
            vncPreview = await backend.previewUrl(handle, CLOUD_VNC_PORT);
          } catch {
            vncPreview = undefined;
          }
        }
        let portlessVncAliasName: string | undefined;
        let portlessVncUrlResolved: string | undefined;
        if (portlessOpt && vncPreview) {
          const vncAlias = `vnc-${name}`;
          const url = await registerHostPortlessAlias({
            alias: vncAlias,
            previewUrl: vncPreview.url,
            label: 'vnc',
            onLog: log,
          });
          if (url) {
            portlessVncAliasName = vncAlias;
            portlessVncUrlResolved = url;
          }
        }
        // Per-service preview URLs. Each `services.*.expose.port` from
        // `agentbox.yaml` gets a direct preview URL alongside the main
        // WebProxy URL — lets users hit services without going through the
        // WebProxy. Best-effort: a failed `previewUrl` for a given port
        // just omits it from the map.
        const servicePorts = exposeServicePorts;
        const servicePreviews: Record<number, string> = {};
        for (const port of servicePorts) {
          if (port === CLOUD_WEB_PROXY_PORT) continue;
          try {
            const p = await backend.previewUrl(handle, port);
            servicePreviews[port] = p.url;
          } catch {
            // skip this port; the user can still hit the service via the
            // WebProxy if the YAML wires `expose.as: 80`.
          }
        }

        // The bridge preview URL is critical: it's how the host CloudBoxPoller
        // reaches the in-sandbox relay. The ctl daemon binds 0.0.0.0:8788 in
        // box mode (cloud), so the Daytona preview proxy can route to it.
        let relayPreview: { url: string; token?: string } | undefined;
        try {
          relayPreview = await backend.previewUrl(handle, 8788);
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
          // `container` carries the sandbox id with a `cloud:` prefix —
          // unique within state, never collides with a real docker
          // container, and grepping for `agentbox-cloud-*` (the old
          // synthetic value) finds nothing now. `image` mirrors the
          // resolved cloud image so `BoxRecord.image: string` stays
          // required without docker-internal readers seeing `undefined`.
          container: `cloud:${handle.sandboxId}`,
          image,
          workspacePath: req.workspacePath,
          projectRoot: req.projectRoot,
          projectIndex,
          relayToken,
          withPlaywright: req.withPlaywright,
          withEnv: req.withEnv,
          carry: carrySummary,
          portlessAlias: portlessAliasName,
          portlessUrl: portlessUrlResolved,
          portlessVncAlias: portlessVncAliasName,
          portlessVncUrl: portlessVncUrlResolved,
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
            previewUrls: ((): Record<number, string> | undefined => {
              const m: Record<number, string> = { ...servicePreviews };
              if (webPreview) m[CLOUD_WEB_PROXY_PORT] = webPreview.url;
              return Object.keys(m).length > 0 ? m : undefined;
            })(),
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
      // Re-mint per-service preview URLs from `agentbox.yaml`. Daytona's
      // preview URLs rotate when a sandbox restarts, so any cached ports
      // need to be re-resolved against the live handle.
      const servicePreviews: Record<number, string> = {};
      try {
        const ports = await readExposedServicePorts(box.workspacePath);
        for (const port of ports) {
          if (port === webPort) continue;
          try {
            const p = await backend.previewUrl(h, port);
            servicePreviews[port] = p.url;
          } catch {
            // skip — falls back to cached value below if any
          }
        }
      } catch {
        // workspace path missing / yaml unreadable: keep cached previewUrls
      }
      let relayPreview: { url: string; token?: string } | undefined;
      try {
        relayPreview = await backend.previewUrl(h, 8788);
      } catch {
        relayPreview = box.cloud?.relayPreviewUrl
          ? { url: box.cloud.relayPreviewUrl, token: box.cloud.relayPreviewToken }
          : undefined;
      }
      // Build the refreshed preview map: keep cached values for ports we
      // couldn't re-resolve, overlay fresh URLs from this start.
      const mergedPreviews: Record<number, string> = {
        ...(box.cloud?.previewUrls ?? {}),
        ...servicePreviews,
      };
      if (webPreview !== undefined) mergedPreviews[webPort] = webPreview.url;

      // Portless: the `ssh -L` local port is fresh after `agentbox start`
      // (pickFreePort picks again), and the in-VPS portless proxy died with
      // the VPS. Re-register the host alias against the new local port and
      // bring the in-box mirror back up. Skipped when no host portless alias
      // was set originally (user opted out at create) or when the URL is
      // non-loopback (Daytona).
      let portlessAliasName: string | undefined = box.portlessAlias;
      let portlessUrlResolved: string | undefined = box.portlessUrl;
      if (box.portlessAlias && webPreview) {
        const r = await bootstrapPortlessForCloudBox(backend, h, {
          boxName: box.name,
          webPreviewUrl: webPreview.url,
          webPort,
          onLog: () => {},
        });
        if (r) {
          portlessAliasName = r.alias;
          portlessUrlResolved = r.url;
        }
      }
      // Same story for the VNC alias — the ssh -L port for 6080 is fresh.
      // Best-effort, silent (startBox has no onLog). Skipped when no VNC
      // alias was set at create.
      let portlessVncAliasName: string | undefined = box.portlessVncAlias;
      let portlessVncUrlResolved: string | undefined = box.portlessVncUrl;
      if (box.portlessVncAlias && box.vncEnabled) {
        try {
          const vncPreview = await backend.previewUrl(h, CLOUD_VNC_PORT);
          const url = await registerHostPortlessAlias({
            alias: box.portlessVncAlias,
            previewUrl: vncPreview.url,
            label: 'vnc',
            onLog: () => {},
          });
          if (url) {
            portlessVncAliasName = box.portlessVncAlias;
            portlessVncUrlResolved = url;
          }
        } catch {
          /* best-effort */
        }
      }

      const next: BoxRecord = {
        ...box,
        portlessAlias: portlessAliasName,
        portlessUrl: portlessUrlResolved,
        portlessVncAlias: portlessVncAliasName,
        portlessVncUrl: portlessVncUrlResolved,
        cloud: {
          ...(box.cloud ?? { backend: providerName, sandboxId: h.sandboxId }),
          webPort,
          previewUrls: Object.keys(mergedPreviews).length > 0 ? mergedPreviews : undefined,
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
        relayUrl: `http://127.0.0.1:${String(8788)}`,
        relayToken: box.relayToken ?? '',
        bridgeToken: box.cloud?.bridgeToken,
      });
      // Re-launch in-box dockerd — also dies with the sandbox. Best-effort,
      // mirrors the docker provider's lifecycle.ts:276 relaunch. Skipped for
      // backends that can't run nested containers (vercel).
      if (opts.launchDockerd !== false) {
        try {
          const dockerd = await launchCloudDockerdDaemon({ backend, handle: h, timeoutMs: 60_000 });
          if (!dockerd.up) {
            // swallowed; surface only on follow-up `docker info`
          }
        } catch {
          // best-effort
        }
      }
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
      // Best-effort: drop the host Portless aliases (web + vnc) so neither
      // `<box>.localhost` nor `vnc-<box>.localhost` keeps pointing at a dead
      // ssh -L. The in-VPS portless dies with the VPS.
      if (box.portlessAlias) {
        try {
          await portlessUnalias(box.portlessAlias);
        } catch {
          // portlessUnalias swallows already; paranoid catch in case.
        }
      }
      if (box.portlessVncAlias) {
        try {
          await portlessUnalias(box.portlessVncAlias);
        } catch {
          // best-effort
        }
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
      // Prefer the stable Portless URL for the `web` endpoint when one was
      // registered — matches Docker's endpoint shape (sandbox-docker/src/
      // endpoints.ts:108-117) so `<name>.localhost` shows up uniformly in
      // `agentbox list` / `inspect`. Falls back to the ephemeral preview URL
      // when Portless wasn't enabled or didn't take.
      const portlessWebUrl =
        box.portlessAlias !== undefined
          ? (box.portlessUrl ?? `https://${box.portlessAlias}.localhost`)
          : undefined;
      const cachedWebUrl = box.cloud?.previewUrls?.[webPort];
      const webUrl = portlessWebUrl ?? cachedWebUrl;
      // Surface each per-service preview URL alongside the main WebProxy.
      // Naming is `service-<port>` because we don't track the YAML name
      // -> port map on the record (avoids extra wire shape just for
      // display).
      const endpoints: Array<{
        kind: 'web';
        name: string;
        containerPort: number;
        url: string;
        reachable: boolean;
      }> = [];
      if (webUrl) {
        endpoints.push({
          kind: 'web',
          name: 'web',
          containerPort: webPort,
          url: webUrl,
          reachable: true,
        });
      }
      for (const [portStr, url] of Object.entries(box.cloud?.previewUrls ?? {})) {
        const port = Number.parseInt(portStr, 10);
        if (!Number.isFinite(port) || port === webPort) continue;
        endpoints.push({
          kind: 'web',
          name: `service-${String(port)}`,
          containerPort: port,
          url,
          reachable: true,
        });
      }
      return {
        record: box,
        state,
        endpoints: {
          domain: webUrl ? new URL(webUrl).host : '',
          domainIsOrb: false,
          endpoints,
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
      // A `detached` build only creates the session (no `exec tmux attach`), so
      // it runs as a plain non-interactive exec — no TTY needed.
      const argv = opts?.detached
        ? [...baseArgv.slice(1), inner]
        : [...baseArgv.slice(1), '-t', inner];
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
      // Prefer the stable Portless URL when one was registered (Hetzner gets
      // both; Daytona naturally skips since previewUrl is non-loopback). The
      // `--loopback` flag forces the raw signed/loopback path instead.
      if (!opts?.loopback) {
        if (kind === 'web' && box.portlessAlias) {
          return box.portlessUrl ?? `https://${box.portlessAlias}.localhost`;
        }
        if (kind === 'vnc' && box.portlessVncAlias) {
          return box.portlessVncUrl ?? `https://${box.portlessVncAlias}.localhost`;
        }
      }
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
 * Three-stage: ensure the session exists (idempotent), apply the same
 * tmux configuration the docker provider uses (prefix remap, extended-keys,
 * `status off` to hide the inner status bar so it doesn't double up with
 * the wrapped-pty footer — see {@link buildTmuxConfigShellSnippet}), then
 * `exec tmux attach`. We can't use `tmux new-session -A` here because it
 * would attach before the `set` commands run; `has-session || new-session -d`
 * keeps the session detached long enough to configure it. `-c /workspace`
 * starts the session in the box's workspace dir so claude/codex/opencode
 * see /workspace as their cwd (otherwise tmux inherits the SSH login
 * shell's $HOME and the agents prompt for workspace-trust).
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
  const sessionQ = shellSingle(sessionName);
  const cwdQ = shellSingle(CLOUD_WORKSPACE_DIR);
  const fallbackQ = shellSingle(fallback);
  const configSnippet = buildTmuxConfigShellSnippet(sessionName);
  const lines = [
    `command -v tmux >/dev/null || { echo "tmux not installed in sandbox"; exit 127; }`,
    `tmux has-session -t ${sessionQ} 2>/dev/null || tmux new-session -d -c ${cwdQ} -s ${sessionQ} ${fallbackQ}`,
    configSnippet,
  ];
  // `detached`: create + configure the session but don't attach. Used to
  // pre-start a session with its full launch command before a new-tab attach
  // re-invokes `agentbox <agent> attach` (which carries no launch args).
  if (opts?.detached) return lines.join('; ');
  return [...lines, `exec tmux attach -t ${sessionQ}`].join('; ');
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
    case 'logs': {
      if (!opts?.service) {
        return 'echo "no service specified — set BuildAttachOptions.service"';
      }
      // Prefer `agentbox-ctl logs` so the cloud follow stream matches the
      // docker format (timestamps + stream marker, ring-buffered tail). The
      // ctl daemon binds the unix socket regardless of how we exec in.
      const tail = opts.tail !== undefined ? String(opts.tail) : '200';
      const args = [`--tail ${shellSingle(tail)}`];
      if (opts.follow !== false) args.push('--follow');
      return `/usr/local/bin/agentbox-ctl logs ${shellSingle(opts.service)} ${args.join(' ')}`;
    }
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
