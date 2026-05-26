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
} from '@agentbox/core';
import { createBox, type CreateBoxOptions } from './create.js';
import { destroyBox, inspectBox, pauseBox, startBox, stopBox, unpauseBox } from './lifecycle.js';
import { execInBox, inspectContainerStatus } from './docker.js';
import { boxResourceStats } from './stats.js';
import { detectEngine } from './host-export.js';
import { portlessGetUrl } from './portless.js';
import { DEFAULT_BOX_IMAGE, buildImage, imageExists } from './image.js';
import {
  computeDockerContextFingerprint,
  preparedMatches,
  readPreparedDockerState,
  writePreparedDockerState,
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
      image: req.image,
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
    };
    const result = await createBox(opts);
    return {
      record: { ...result.record, provider: 'docker' },
      imageBuilt: result.imageBuilt,
    };
  },

  async start(box: BoxRecord): Promise<BoxRecord> {
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
    hostSrc: string,
    boxDst: string,
  ): Promise<{ finalPath: string }> {
    const r = await uploadToBox(box, hostSrc, boxDst);
    return { finalPath: r.finalPath };
  },

  async downloadPath(
    box: BoxRecord,
    boxSrc: string,
    hostDst: string,
  ): Promise<{ finalPath: string }> {
    const r = await downloadFromBox(box, boxSrc, hostDst);
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
      // OrbStack auto-routes <container>.orb.local to container :80.
      return `http://${box.container}.orb.local`;
    }
    if (box.portlessAlias && !opts?.loopback) {
      return box.portlessUrl ?? (await portlessGetUrl(box.portlessAlias));
    }
    if (box.webHostPort === undefined) {
      throw new Error(
        `web port not resolved for box ${box.name}; is the container running?`,
      );
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
    const fingerprint = await computeDockerContextFingerprint();
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

    opts.onLog?.(`building docker image ${ref}…`);
    await buildImage({ ref, onProgress: opts.onLog });
    if (fingerprint) {
      writePreparedDockerState({ imageRef: ref, contextSha256: fingerprint.contextSha256 });
      opts.onLog?.(
        `docker image ${ref} built; recorded fingerprint ${fingerprint.contextSha256.slice(0, 12)}`,
      );
    } else {
      opts.onLog?.(`docker image ${ref} built (fingerprint unavailable, prepared state not written)`);
    }
    return {};
  },
};
