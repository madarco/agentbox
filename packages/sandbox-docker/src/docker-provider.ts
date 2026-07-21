/**
 * `DockerProvider` — the local-Docker implementation of the provider-neutral
 * `Provider` interface. A thin adapter: every method delegates to the existing
 * `createBox` / lifecycle / docker / stats functions. The CLI resolves this via
 * the provider registry for any box whose `provider` is `'docker'`.
 */

import type {
  BoxRecord,
  BoxResourceStats,
  BoxRuntimeState,
  CreateBoxRequest,
  CreatedBox,
  ExecOptions,
  ExecResult,
  InspectedBox,
  PrepareOptions,
  PrepareResult,
  Provider,
  ProviderSync,
  ResyncResult,
  SyncTransport,
} from '@agentbox/core';
import { claudeInstallFingerprint, makeSyncContext } from '@agentbox/sandbox-core';
import { makeDockerSync } from './sync/docker-sync.js';
import { createDockerSyncTransport } from './sync/sync-transport.js';
import { createBox, type CreateBoxOptions } from './create.js';
import { destroyBox, inspectBox, pauseBox, startBox, stopBox, unpauseBox } from './lifecycle.js';
import { execInBox, inspectContainerStatus } from './docker.js';
import { boxResourceStats } from './stats.js';
import { detectEngine } from './sync/host-export.js';
import { portlessGetUrl } from './portless.js';
import { DEFAULT_BOX_IMAGE, imageExists, pullOrBuild } from './image.js';
import {
  computeDockerContextFingerprint,
  preparedMatches,
  readPreparedDockerState,
} from './prepared-state.js';
import { downloadFromBox, uploadToBox } from './box-cp.js';

/**
 * Docker-specific knobs the CLI passes through `CreateBoxRequest.providerOptions`.
 * Kept out of the provider-neutral `CreateBoxRequest` so cloud backends don't
 * carry Docker concepts.
 */
export interface DockerCreateOptions {
  useSnapshot?: boolean;
  sharedCache?: boolean;
  portless?: boolean;
  portlessStateDir?: string;
  claudeConfig?: { isolate: boolean };
  codexConfig?: { isolate: boolean };
  opencodeConfig?: { isolate: boolean };
  claudeEnv?: Record<string, string>;
}

export const dockerProvider: Provider = {
  name: 'docker',

  async create(req: CreateBoxRequest): Promise<CreatedBox> {
    const po = (req.providerOptions ?? {}) as DockerCreateOptions;
    const opts: CreateBoxOptions = {
      workspacePath: req.workspacePath,
      name: req.name,
      useSnapshot: po.useSnapshot ?? false,
      checkpointRef: req.checkpointRef,
      fromBranch: req.fromBranch,
      useBranch: req.useBranch,
      resyncOnStart: req.resyncOnStart,
      image: req.image,
      allowPull: req.allowPull,
      imageRegistry: req.imageRegistry,
      onLog: req.onLog,
      claudeConfig: po.claudeConfig,
      claudeEnv: po.claudeEnv,
      codexConfig: po.codexConfig,
      opencodeConfig: po.opencodeConfig,
      withPlaywright: req.withPlaywright,
      withEnv: req.withEnv,
      envFilesToImport: req.envFilesToImport,
      carry: req.carry,
      vnc: req.vnc,
      docker: po.sharedCache !== undefined ? { sharedCache: po.sharedCache } : undefined,
      portless: po.portless,
      portlessStateDir: po.portlessStateDir,
      projectRoot: req.projectRoot,
      limits: req.limits ?? undefined,
      credentialSync: req.credentialSync,
    };
    const result = await createBox(opts);
    return {
      record: { ...result.record, provider: 'docker' },
      imageBuilt: result.imageBuilt,
      resync: result.resync,
    };
  },

  async start(box: BoxRecord): Promise<BoxRecord> {
    const { record } = await startBox(box.id);
    return { ...record, provider: 'docker' };
  },

  async reconnect(box: BoxRecord): Promise<BoxRecord> {
    // Reconnect re-establishes host-side wiring without a needless power-cycle.
    // A PAUSED container can't `docker start` ("cannot start a paused
    // container") — unpause resumes its still-frozen ctl/dockerd/vnc, and the
    // portless alias is untouched by pause, so that's all it needs. A running or
    // stopped container goes through `startBox`, which is idempotent (a
    // `docker start` on a live container is a no-op) and relaunches the daemons
    // + re-registers portless — the work a host reboot / relay restart needs.
    const insp = await inspectBox(box.id);
    if (insp.state === 'missing' || insp.state === 'destroyed') {
      throw new Error(`box ${box.name} has no container; was it destroyed?`);
    }
    if (insp.state === 'paused') {
      const record = await unpauseBox(box.id);
      return { ...record, provider: 'docker' };
    }
    const { record } = await startBox(box.id);
    return { ...record, provider: 'docker' };
  },

  async pause(box: BoxRecord): Promise<void> {
    await pauseBox(box.id);
  },

  async resume(box: BoxRecord): Promise<void> {
    await unpauseBox(box.id);
  },

  async stop(box: BoxRecord): Promise<void> {
    await stopBox(box.id);
  },

  async destroy(box: BoxRecord): Promise<void> {
    await destroyBox(box.id);
  },

  async resyncWorkspace(box: BoxRecord, onLog?: (line: string) => void): Promise<ResyncResult> {
    // Merge the host's current branch into each per-box worktree + overlay the
    // host's uncommitted/untracked (box wins). Reproduces `resyncBox`: the
    // facade short-circuits when the box has no worktrees. Only `ctx.onLog` is
    // read by resync (the concern reads each worktree's hostMainRepo).
    const ctx = makeSyncContext({
      boxName: box.name,
      boxId: box.id,
      provider: 'docker',
      hostWorkspace: box.workspacePath,
      onLog,
    });
    return makeDockerSync({ container: box.container }).resyncWorkspace(ctx, box.gitWorktrees ?? []);
  },

  sync(box: BoxRecord): ProviderSync {
    return makeDockerSync({ container: box.container });
  },

  syncTransport(box: BoxRecord): SyncTransport {
    return createDockerSyncTransport({ container: box.container, image: box.image });
  },

  async inspect(box: BoxRecord): Promise<InspectedBox> {
    const insp = await inspectBox(box.id);
    return {
      record: insp.record,
      // The Docker `BoxState` adds a 'destroyed' value the provider-neutral
      // `BoxRuntimeState` folds into 'missing'.
      state: insp.state === 'destroyed' ? 'missing' : insp.state,
      endpoints: insp.endpoints,
      raw: insp.dockerInspect,
    };
  },

  async probeState(box: BoxRecord): Promise<BoxRuntimeState> {
    return inspectContainerStatus(box.container);
  },

  async stats(box: BoxRecord): Promise<BoxResourceStats> {
    return boxResourceStats(box);
  },

  async exec(box: BoxRecord, argv: string[], opts?: ExecOptions): Promise<ExecResult> {
    const r = await execInBox(box.container, argv, opts?.user ? { user: opts.user } : {});
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  },

  async uploadPath(
    box: BoxRecord,
    hostSrcs: string[],
    boxDst: string,
    exclude?: string[],
  ): Promise<{ finalPath: string }> {
    const r = await uploadToBox(box, hostSrcs, boxDst, exclude);
    return { finalPath: r.finalPath };
  },

  async downloadPath(
    box: BoxRecord,
    boxSrcs: string[],
    hostDst: string,
    exclude?: string[],
  ): Promise<{ finalPath: string }> {
    const r = await downloadFromBox(box, boxSrcs, hostDst, exclude);
    return { finalPath: r.finalPath };
  },

  async resolveUrl(
    box: BoxRecord,
    opts?: { loopback?: boolean; kind?: 'web' | 'vnc'; ttl?: number },
  ): Promise<string> {
    if (box.webContainerPort === undefined) {
      throw new Error(
        `box ${box.name} predates the reserved web port; recreate it to use \`agentbox url\``,
      );
    }
    const engine = await detectEngine();
    if (engine === 'orbstack' && !opts?.loopback) {
      // OrbStack auto-routes <container>.orb.local to the container; :80 is
      // declared (EXPOSE 80) so no port suffix is needed.
      return `http://${box.container}.orb.local`;
    }
    if (box.portlessAlias && !opts?.loopback) {
      return box.portlessUrl ?? (await portlessGetUrl(box.portlessAlias));
    }
    if (box.webHostPort === undefined) {
      throw new Error(`web port not resolved for box ${box.name}; is the container running?`);
    }
    return `http://127.0.0.1:${String(box.webHostPort)}`;
  },

  async prepare(opts: PrepareOptions): Promise<PrepareResult> {
    // Docker uses the rsync-into-named-volume flow at create time, so the
    // base image stays generic — no agent-config layering. `prepare` here is
    // just an explicit handle on the build step `agentbox create` does
    // lazily on first use. Idempotent: skip when the image exists *and* the
    // build-context fingerprint matches the recorded one. `--force`
    // overrides both checks.
    const ref = DEFAULT_BOX_IMAGE;
    const claudeInstall = opts.claudeInstall ?? 'native';
    const rawFingerprint = await computeDockerContextFingerprint();
    // Fold the install mode into the sha so native↔npm are distinct cache
    // identities (`native` leaves the hash unchanged).
    const fingerprint = rawFingerprint
      ? {
          ...rawFingerprint,
          contextSha256: claudeInstallFingerprint(rawFingerprint.contextSha256, claudeInstall),
        }
      : null;
    const prepared = readPreparedDockerState();

    if (!opts.force) {
      const exists = await imageExists(ref);
      if (exists && fingerprint && preparedMatches(prepared, fingerprint.contextSha256)) {
        opts.onLog?.(
          `docker image ${ref} up to date (fingerprint ${fingerprint.contextSha256.slice(0, 12)}) — skipping (use --force to rebuild)`,
        );
        return {};
      }
      if (exists && !fingerprint) {
        opts.onLog?.(
          `docker image ${ref} present but build context could not be fingerprinted — skipping (use --force to rebuild)`,
        );
        return {};
      }
    }

    // `--force` skips the registry pull and always builds a fresh local image.
    // npm mode pulls like any other: CI publishes both install variants, and the
    // fingerprint is folded with the mode, so the pull asks for the npm image's
    // own tag. An unpublished tag still falls back to a local build.
    const npm = claudeInstall === 'npm';
    const { source } = await pullOrBuild(ref, fingerprint, {
      onProgress: opts.onLog,
      allowPull: opts.force ? false : opts.allowPull,
      registry: opts.registry,
      buildArgs: npm ? { AGENTBOX_CLAUDE_INSTALL: 'npm' } : undefined,
    });
    if (fingerprint) {
      opts.onLog?.(
        `docker image ${ref} ${source}; recorded fingerprint ${fingerprint.contextSha256.slice(0, 12)}`,
      );
    } else {
      opts.onLog?.(
        `docker image ${ref} ${source} (fingerprint unavailable, prepared state not written)`,
      );
    }
    return {};
  },
};
