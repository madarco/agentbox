/**
 * `agentbox prepare --provider tenki` — make the AgentBox base image available
 * in the user's Tenki workspace registry so per-box `create` boots ready in
 * seconds.
 *
 * Tenki boots a session from a registry image ref (`workspace/name:tag`) or a
 * snapshot id — it does not pull arbitrary external OCI refs at create time.
 * So `prepare` gets the AgentBox box image (published to GHCR as
 * `ghcr.io/madarco/agentbox/box`) INTO Tenki's registry, then records the
 * resolved ref in `~/.agentbox/tenki-prepared.json`.
 *
 * Two paths:
 *   1. Explicit ref (`--image` / `AGENTBOX_TENKI_BASE_IMAGE`): the image is
 *      already published to your Tenki workspace registry — we just resolve +
 *      pin it. The reliable path when you've pushed the image yourself.
 *   2. Auto-build (default): build a Tenki template FROM the GHCR parent image
 *      (`createTemplate({ parentImage }) → buildTemplate → waitForTemplateBuild`),
 *      then `publishRegistryImage` from the build snapshot and pin the resolved
 *      ref. Requires Tenki to be able to pull the parent image.
 *
 * vCPU / RAM are template-level here so per-box `create` doesn't fight them.
 */

import type { Provider } from '@agentbox/core';
import { readCliStamp } from '@agentbox/sandbox-core';
import { ensureTenkiCredentials } from './credentials.js';
import { getTenkiClient, resolveAuthToken } from './sdk.js';
import { preparedStatePath, readPreparedState, writePreparedState } from './prepared-state.js';

/** GHCR ref for the AgentBox box image — the parent the Tenki base is built from. */
const DEFAULT_PARENT_IMAGE = 'ghcr.io/madarco/agentbox/box:dev';
/** Artifact name the base is published under in the Tenki workspace registry. */
const ARTIFACT_NAME = 'agentbox-box';
const DEFAULT_TAG = 'latest';
const DEFAULT_CPU = 2;
const DEFAULT_MEMORY_MB = 4096;
const DEFAULT_DISK_GB = 8;

export interface PrepareTenkiOptions {
  name?: string;
  hostWorkspace?: string;
  /** Force re-publish even when an up-to-date base ref is recorded. */
  force?: boolean;
  /** A pre-published Tenki registry ref to validate + pin (skips the build). */
  image?: string;
  /** External parent image the auto-build path builds the base from. */
  parentImage?: string;
  /** Tenki workspace to publish into (defaults to the first from `whoAmI`). */
  workspaceId?: string;
  /** vCPUs baked into the template (default 2). */
  cpuCount?: number;
  /** Memory in MiB baked into the template (default 4096). */
  memoryMB?: number;
  onLog?: (line: string) => void;
}

export interface PrepareTenkiResult {
  /** The resolved Tenki registry ref recorded as the base image. */
  snapshotName?: string;
}

export async function prepareTenki(opts: PrepareTenkiOptions = {}): Promise<PrepareTenkiResult> {
  await ensureTenkiCredentials();
  resolveAuthToken(); // fail loud before any RPC if creds are missing
  const client = getTenkiClient();
  const log = opts.onLog ?? (() => {});
  const progress = (s: string): void => log(`prepare-tenki: ${s}`);

  const explicit = opts.image ?? process.env.AGENTBOX_TENKI_BASE_IMAGE;

  // Skip-fast: an existing recorded base that still resolves, unless --force.
  const existing = readPreparedState();
  if (!opts.force && existing.base) {
    const target = explicit;
    if (!target || target === existing.base.image) {
      if (await refResolves(client, existing.base.image)) {
        progress(
          `base image ${existing.base.image} already prepared; skipping (pass --force to rebuild)`,
        );
        return { snapshotName: existing.base.image };
      }
      progress(`recorded base ${existing.base.image} no longer resolves; re-preparing`);
    }
  }

  let resolvedRef: string;
  if (explicit) {
    progress(`validating provided base image ref ${explicit}`);
    const r = await client.resolveRegistryRef(explicit);
    resolvedRef = r.resolvedRef;
  } else {
    const identity = await client.whoAmI();
    const workspaceId =
      opts.workspaceId ??
      process.env.AGENTBOX_TENKI_WORKSPACE_ID ??
      identity.workspaces[0]?.id;
    if (!workspaceId) {
      throw new Error(
        'tenki prepare: no workspace found for these credentials — pass --workspace or set AGENTBOX_TENKI_WORKSPACE_ID',
      );
    }
    const parentImage =
      opts.parentImage ?? process.env.AGENTBOX_TENKI_PARENT_IMAGE ?? DEFAULT_PARENT_IMAGE;

    progress(`creating template '${ARTIFACT_NAME}' from parent image ${parentImage}`);
    const template = await client.createTemplate({
      workspaceId,
      name: ARTIFACT_NAME,
      parentImage,
      setupScript: '',
      resources: {
        cpuCores: opts.cpuCount ?? DEFAULT_CPU,
        memoryMb: opts.memoryMB ?? DEFAULT_MEMORY_MB,
        diskSizeGb: DEFAULT_DISK_GB,
      },
    });

    progress(`building template ${template.id}`);
    const build = await client.buildTemplate(template.id);
    const done = await client.waitForTemplateBuild(build.id);
    if (done.state !== 'READY' || !done.snapshotId) {
      throw new Error(
        `tenki prepare: template build ${build.id} ended in state ${done.state}` +
          (done.error ? `: ${done.error}` : ''),
      );
    }

    progress(`publishing registry image from build snapshot ${done.snapshotId}`);
    const published = await client.publishRegistryImage({
      fromSnapshotId: done.snapshotId,
      workspaceId,
      name: ARTIFACT_NAME,
      tag: DEFAULT_TAG,
      visibility: 'private',
    });
    resolvedRef =
      published.digestRef ||
      published.tag?.ref ||
      `${identity.workspaces[0]?.name ?? workspaceId}/${ARTIFACT_NAME}:${DEFAULT_TAG}`;
  }

  const cliStamp = readCliStamp();
  writePreparedState({
    schema: 1,
    base: {
      image: resolvedRef,
      imageName: ARTIFACT_NAME,
      cliVersion: cliStamp.cliVersion,
      cliCommit: cliStamp.cliCommit,
      createdAt: new Date().toISOString(),
    },
  });
  progress(`wrote ${preparedStatePath()}`);
  progress(`prepare complete — base image ${resolvedRef}`);
  return { snapshotName: resolvedRef };
}

/** True when a registry ref still resolves (used by the skip-fast path). */
async function refResolves(
  client: ReturnType<typeof getTenkiClient>,
  ref: string,
): Promise<boolean> {
  try {
    await client.resolveRegistryRef(ref);
    return true;
  } catch {
    return false;
  }
}

/** Provider-level binding used by the CLI's `prepare` command. */
export const prepareTenkiProvider: NonNullable<Provider['prepare']> = (req) =>
  prepareTenki({
    name: req.name,
    hostWorkspace: req.hostWorkspace ?? process.cwd(),
    force: req.force,
    // Box size is applied at create (see `box.sizeTenki` → the backend's
    // create-time resources), so `--size` is intentionally not baked into the
    // template here. A pre-published ref is pinned via `AGENTBOX_TENKI_BASE_IMAGE`.
    onLog: req.onLog,
  });
