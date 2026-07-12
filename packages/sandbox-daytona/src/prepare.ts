/**
 * Daytona-side implementation of the `Provider.prepare` hook (`agentbox
 * prepare --provider daytona`). One-time, user-triggered:
 *
 *   1. Stage filtered tarballs of the host's `~/.claude`, `~/.codex`, and
 *      `~/.local/share/opencode` static config (no auth tokens — those go on
 *      the per-org `agentbox-credentials` volume at create time).
 *   2. Build a layered Daytona `Image`: start from `Dockerfile.box`, then
 *      `.addLocalFile()` each staged tarball + `.runCommands()` to extract
 *      them into the right paths inside the image.
 *   3. Call `daytona.snapshot.create({ name, image }, { onLogs })` — Daytona
 *      runs the build server-side, registers the result as an org-scoped
 *      named snapshot, and returns when it's `active`.
 *
 * Replaces the old `agentbox daytona publish-snapshot` flow that
 * provisioned a sandbox + ran an in-sandbox bake + called the broken
 * `_experimental_createSnapshot`. The new path never provisions a sandbox.
 *
 * Source of truth for the public API:
 * https://www.daytona.io/docs/en/snapshots/
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Image } from '@daytona/sdk';
import type { PrepareOptions, PrepareResult } from '@agentbox/core';
import { DAYTONA_VM_REGION, type DaytonaSandboxClass } from '@agentbox/config';
import {
  claudeInstallFingerprint,
  stageAllAgentStatic,
  type AgentStaticStage,
} from '@agentbox/sandbox-core';
import { daytonaBackend, getClient, parseDaytonaSize } from './backend.js';
import { resolveDaytonaCustomClaudeMd, resolveDockerfileContext } from './dockerfile-context.js';
import { ensureDaytonaEnvLoaded } from './env-loader.js';
import { bakeDaytonaVmBase, VmBaseImageUnavailableError } from './prepare-vm.js';
import {
  computeDaytonaContextFingerprint,
  computeDockerBaseSha,
  preparedMatches,
  readPreparedDaytonaState,
  writePreparedDaytonaState,
} from './prepared-state.js';

/**
 * Default snapshot name. Keyed on the first 12 chars of the build-context
 * fingerprint so identical content produces the same snapshot name across
 * machines / CLI runs (idempotent): if the named snapshot already exists
 * on Daytona, prepare can short-circuit without uploading the build
 * context again. Falls back to a timestamp when fingerprinting fails
 * (partial dev rebuild).
 */
export function defaultSnapshotName(
  fingerprint: string | null,
  sizeKey?: string,
  sandboxClass?: DaytonaSandboxClass,
): string {
  // The size suffix keeps re-sized bakes from colliding on one name, so a
  // `--size 2-4-8` snapshot doesn't overwrite the `4-8-20` one. Same for the
  // class: a VM and a container snapshot of the same context are different
  // artifacts and cannot substitute for each other. Container stays unsuffixed
  // so existing snapshot names keep resolving.
  const suffix = `${sizeKey ? `-${sizeKey}` : ''}${sandboxClass === 'linux-vm' ? '-vm' : ''}`;
  if (fingerprint) return `agentbox-base-${fingerprint.slice(0, 12)}${suffix}`;
  return `agentbox-base-${Math.floor(Date.now() / 1000).toString()}${suffix}`;
}

/**
 * Daytona build paths for a staged tool. The tarball is copied into the seed
 * build-context dir under `contextRel` (a RELATIVE name — the Daytona builder
 * only resolves COPY sources that map to a relative archive entry; an absolute
 * `addLocalFile` COPY silently fails to land), then COPYed to `remoteTar`.
 */
function daytonaSeedPaths(kind: AgentStaticStage['kind']): { contextRel: string; remoteTar: string } {
  return {
    contextRel: `agentbox-seed-${kind}.tar.gz`,
    remoteTar: `/tmp/agentbox-seed-${kind}.tar.gz`,
  };
}

/** Relative name the daytona CLAUDE.md overlay is staged under in the seed context dir. */
const DAYTONA_CLAUDE_MD_REL = 'agentbox-custom-CLAUDE.md';

/**
 * Build the appended Dockerfile commands for the seed bake. Every `COPY` source
 * is a RELATIVE name resolved against the seed build-context dir — the Daytona
 * builder drops absolute-source COPYs (they archive to a stripped relative entry
 * that the absolute source can't reference), so relative names are mandatory.
 * Runs as root (COPY drops files root-owned; chown -R + /etc/claude-code need
 * root), then restores `USER vscode` so the image keeps its default-user invariant.
 * Pure + exported for the regression test.
 */
export function buildDaytonaSeedCommands(
  usable: ReadonlyArray<Pick<AgentStaticStage, 'kind' | 'extractDir'>>,
): string[] {
  const cmds: string[] = [
    'USER root',
    `COPY ${DAYTONA_CLAUDE_MD_REL} /tmp/agentbox-custom-CLAUDE.md`,
    ...usable.map((s) => `COPY ${daytonaSeedPaths(s.kind).contextRel} ${daytonaSeedPaths(s.kind).remoteTar}`),
    'RUN install -m 0644 /tmp/agentbox-custom-CLAUDE.md /etc/claude-code/CLAUDE.md && rm -f /tmp/agentbox-custom-CLAUDE.md',
    ...usable.map(
      (s) =>
        `RUN mkdir -p ${s.extractDir} && tar -xzf ${daytonaSeedPaths(s.kind).remoteTar} -C ${s.extractDir} --no-same-permissions --no-same-owner -m`,
    ),
  ];
  if (usable.length > 0) {
    // Own the extracted trees as the box user, then drop the staging tarballs.
    // ~/.agents is only present when the host had one (skills dir); guard it.
    cmds.push(
      'RUN chown -R vscode:vscode /home/vscode/.claude /home/vscode/.codex /home/vscode/.local' +
        ' && ( [ -d /home/vscode/.agents ] && chown -R vscode:vscode /home/vscode/.agents || true )' +
        ' && rm -f /tmp/agentbox-seed-*.tar.gz',
    );
  }
  cmds.push('USER vscode');
  return cmds;
}

/**
 * Run `agentbox prepare --provider daytona`. Returns `{ snapshotName }` on
 * success so the CLI can pin it into the project config.
 */
export async function prepareDaytona(opts: PrepareOptions): Promise<PrepareResult> {
  ensureDaytonaEnvLoaded();
  const log = opts.onLog ?? (() => {});

  // Fingerprint the build context first so we can (a) name the snapshot
  // deterministically and (b) detect cache hits against the recorded
  // prepared state. Computed before staging so an early `null` (partial
  // dev rebuild) doesn't waste a tar staging cycle.
  const claudeInstall = opts.claudeInstall ?? 'native';

  // Bake-time resources. A `--size` / `box.sizeDaytona` like `4-8-20` sets the
  // snapshot's baked CPU/memory/disk (Daytona rejects resources on the create
  // snapshot path, so it MUST be set here). Normalize to a canonical
  // `cpu-memory-disk` string for the snapshot-name suffix + prepared-state so
  // `04-08-20` and `4-8-20` don't fork the cache.
  const sizeSpec = opts.size?.trim() || undefined;
  const sizeResources = sizeSpec ? parseDaytonaSize(sizeSpec) : undefined;
  if (sizeSpec && !sizeResources) {
    throw new Error(
      `invalid --size '${sizeSpec}' for daytona: expected 'cpu-memory-disk' GB, e.g. '4-8-20'.`,
    );
  }
  const sizeKey = sizeResources
    ? `${String(sizeResources.cpu)}-${String(sizeResources.memory)}-${String(sizeResources.disk)}`
    : undefined;

  // The class is fixed at bake time — a snapshot of one class cannot create a
  // sandbox of the other — so it belongs in the snapshot name and the cache key.
  let sandboxClass: DaytonaSandboxClass =
    opts.sandboxClass === 'container' ? 'container' : 'linux-vm';
  // CI publishes only the native-install box image (the workflow passes no
  // build-arg), and a VM base can only come from a published image. Rather than
  // dead-end a user who reached for npm mode *because* the native installer was
  // 403ing on their egress IP, fall back to the class that can still be built.
  if (sandboxClass === 'linux-vm' && claudeInstall === 'npm') {
    log(
      'daytona: --claude-install npm has no published box image (CI builds only the native ' +
        'variant), and a linux-vm base must boot from one — baking a container snapshot instead. ' +
        'It will not support pause/resume.',
    );
    sandboxClass = 'container';
  }

  const rawFingerprint = await computeDaytonaContextFingerprint();
  // Fold the install mode into the sha so native↔npm are distinct cache
  // identities (`native` leaves the hash unchanged) — the snapshot name and the
  // prepared-state match both derive from it.
  const fingerprint = rawFingerprint
    ? {
        ...rawFingerprint,
        contextSha256: claudeInstallFingerprint(rawFingerprint.contextSha256, claudeInstall),
      }
    : rawFingerprint;
  // Not const: a linux-vm bake that finds no published base image downgrades to
  // container below, and must then drop the `-vm` suffix from its name.
  let snapshotName =
    opts.name ?? defaultSnapshotName(fingerprint?.contextSha256 ?? null, sizeKey, sandboxClass);

  const prepared = readPreparedDaytonaState();
  if (
    !opts.force &&
    fingerprint &&
    preparedMatches(prepared, fingerprint.contextSha256, sizeKey, sandboxClass)
  ) {
    // Confirm the snapshot still exists on Daytona before short-circuiting.
    // A "yes locally, no on the server" mismatch must rebuild.
    try {
      const existing = await getClient().snapshot.get(
        prepared?.base?.imageRef ?? snapshotName,
      );
      if (existing?.name) {
        log(
          `daytona snapshot '${existing.name}' up to date ` +
            `(fingerprint ${fingerprint.contextSha256.slice(0, 12)}) — skipping rebuild ` +
            `(pass --force to override)`,
        );
        return { snapshotName: existing.name };
      }
      log(
        `recorded snapshot '${prepared?.base?.imageRef ?? snapshotName}' not found on Daytona; rebuilding`,
      );
    } catch {
      log(
        `recorded snapshot lookup failed; rebuilding (pass --force to silence)`,
      );
    }
  } else if (!opts.force && fingerprint && prepared?.base?.contextSha256) {
    const bakedSize = prepared.extras?.size;
    const bakedClass = prepared.extras?.class ?? 'container';
    const sameContext = prepared.base.contextSha256 === fingerprint.contextSha256;
    if (sameContext && bakedClass !== sandboxClass) {
      log(
        `daytona sandbox class changed (was ${bakedClass}, now ${sandboxClass}); rebuilding snapshot`,
      );
    } else if (sameContext && bakedSize !== sizeKey) {
      log(
        `daytona size changed (was ${bakedSize ?? 'default'}, now ${sizeKey ?? 'default'}); ` +
          `rebuilding snapshot`,
      );
    } else {
      log(
        `daytona build context changed (was ${prepared.base.contextSha256.slice(0, 12)}, ` +
          `now ${fingerprint.contextSha256.slice(0, 12)}); rebuilding snapshot`,
      );
    }
  }

  const ctx = resolveDockerfileContext();
  if (!ctx) {
    throw new Error(
      'could not locate AgentBox Dockerfile.box build context for the Daytona snapshot. ' +
        'Set AGENTBOX_DOCKER_CONTEXT to the directory containing Dockerfile.box.',
    );
  }

  const daytonaClaudeMd = resolveDaytonaCustomClaudeMd();
  if (!daytonaClaudeMd) {
    throw new Error(
      'could not locate packages/sandbox-daytona/scripts/custom-system-CLAUDE.md ' +
        '(or its staged runtime/daytona/ copy). Ensure `pnpm -w build` ran so the ' +
        'CLI staging populated runtime/daytona/.',
    );
  }

  if (sandboxClass === 'linux-vm') {
    const dockerBaseSha = await computeDockerBaseSha();
    if (!dockerBaseSha) {
      throw new Error(
        'could not fingerprint the docker build context, which names the published box image ' +
          'a linux-vm base must boot from. Ensure `pnpm -w build` ran, or set ' +
          '`agentbox config set box.daytonaClass container`.',
      );
    }
    try {
      const baked = await bakeDaytonaVmBase({
        client: getClient(opts.location ?? DAYTONA_VM_REGION),
        backend: daytonaBackend,
        regionId: opts.location ?? DAYTONA_VM_REGION,
        snapshotName,
        dockerBaseSha,
        registry: opts.registry,
        ...(sizeResources ? { resources: sizeResources } : {}),
        hostWorkspace: opts.hostWorkspace,
        claudeMdOverlay: daytonaClaudeMd,
        onLog: log,
      });
      if (fingerprint) {
        writePreparedDaytonaState({
          snapshotName: baked,
          contextSha256: fingerprint.contextSha256,
          size: sizeKey,
          class: 'linux-vm',
        });
        log(`recorded daytona-prepared.json (fingerprint ${fingerprint.contextSha256.slice(0, 12)})`);
      }
      return { snapshotName: baked };
    } catch (err) {
      if (!(err instanceof VmBaseImageUnavailableError)) throw err;
      // No published image for this context (a locally edited Dockerfile.box is
      // the usual cause — a contributor, not an end user). Daytona cannot build
      // a VM from a Dockerfile, so the only thing we *can* bake is a container.
      log(
        `daytona: ${err.message} This usually means a locally modified Dockerfile.box. ` +
          `Daytona can't build a linux-vm base from a Dockerfile, so falling back to a ` +
          `container snapshot (no pause/resume).`,
      );
      sandboxClass = 'container';
      // Re-derive the name without the `-vm` suffix, or we'd register a
      // container snapshot under a name that advertises a VM.
      snapshotName =
        opts.name ?? defaultSnapshotName(fingerprint?.contextSha256 ?? null, sizeKey, sandboxClass);
    }
  }

  const stages = await stageAllAgentStatic({ hostWorkspace: opts.hostWorkspace });
  // Surface staging warnings (codex Keychain landmine, etc.) before the
  // longer build kicks off.
  for (const s of stages) {
    for (const w of s.staged.warnings) log(w);
  }

  // The Daytona SDK's `Image.fromDockerfile` takes only a path — no build args —
  // and appended `.env()`/`.runCommands()` land *after* the base Dockerfile's
  // Claude RUN (too late, and a native 403 would already have failed the build).
  // So for npm mode we build from a sibling temp Dockerfile with the
  // `AGENTBOX_CLAUDE_INSTALL` ARG default flipped to `npm`. It must live in the
  // original's directory so the Dockerfile's relative COPY sources still resolve.
  let tempDockerfile: string | null = null;
  const dockerfilePath =
    claudeInstall === 'npm'
      ? (tempDockerfile = writeNpmDockerfile(ctx.dockerfile))
      : ctx.dockerfile;

  // Seed build-context dir: the daytona CLAUDE.md + each staged tarball are
  // copied here under RELATIVE names so the appended `COPY <name>` sources map
  // to relative archive entries the Daytona builder actually reconstructs.
  // (An absolute `addLocalFile` COPY emits `COPY /abs/tmp/x` but archives the
  // entry as the stripped `abs/tmp/x` — the mismatch silently drops the layer.)
  let seedContextDir: string | null = null;
  try {
    // git-lfs (binary + `git lfs install --system`) is inherited for free from
    // Dockerfile.box, so an in-box checkout of an LFS repo smudges real content.
    // No daytona-specific overlay step is needed; the host-side object seeding
    // lives in sandbox-cloud's workspace-seed (seedCloneLfsObjects).
    let image: Image = Image.fromDockerfile(dockerfilePath);

    seedContextDir = mkdtempSync(join(tmpdir(), 'agentbox-daytona-seed-'));
    // Overlay the daytona-specific /etc/claude-code/CLAUDE.md on top of the
    // docker-shaped one baked by Dockerfile.box (daytona boxes have no host
    // .git/ bind-mount, so the in-box hint needs daytona-specific git wording).
    copyFileSync(daytonaClaudeMd, join(seedContextDir, DAYTONA_CLAUDE_MD_REL));

    const usable = stages.filter((s) => s.staged.tarballPath !== null);
    for (const s of usable) {
      copyFileSync(s.staged.tarballPath as string, join(seedContextDir, daytonaSeedPaths(s.kind).contextRel));
    }

    image = image.dockerfileCommands(buildDaytonaSeedCommands(usable), seedContextDir);

    // Region: a container snapshot registers wherever the client points (the
    // account default unless the user pinned `box.daytonaRegion`).
    const client = getClient(opts.location ?? '');
    log(
      `creating Daytona snapshot '${snapshotName}'${sizeResources ? ` (${sizeKey})` : ''}…`,
    );
    const snapshot = await client.snapshot.create(
      {
        name: snapshotName,
        image,
        ...(sizeResources ? { resources: sizeResources } : {}),
        ...(opts.location ? { regionId: opts.location } : {}),
      },
      {
        onLogs: (chunk: string) => log(String(chunk).split('\n').filter(Boolean).join(' ')),
      },
    );
    log(`snapshot '${snapshot.name}' is ${snapshot.state ?? 'created'}`);
    if (fingerprint) {
      writePreparedDaytonaState({
        snapshotName: snapshot.name ?? snapshotName,
        contextSha256: fingerprint.contextSha256,
        size: sizeKey,
        class: 'container',
      });
      log(
        `recorded daytona-prepared.json (fingerprint ${fingerprint.contextSha256.slice(0, 12)})`,
      );
    }
    return { snapshotName: snapshot.name ?? snapshotName };
  } finally {
    await Promise.all(stages.map((s) => s.staged.cleanup()));
    if (tempDockerfile) rmSync(tempDockerfile, { force: true });
    if (seedContextDir) rmSync(seedContextDir, { recursive: true, force: true });
  }
}

/**
 * Write a sibling copy of `Dockerfile.box` with the `AGENTBOX_CLAUDE_INSTALL`
 * ARG default flipped from `native` to `npm`, and return its path. A sibling
 * (same directory) keeps the Dockerfile's relative COPY sources resolvable.
 * Throws if the ARG line isn't found (Dockerfile drifted from this expectation).
 */
function writeNpmDockerfile(originalPath: string): string {
  const original = readFileSync(originalPath, 'utf8');
  const flipped = original.replace(
    'ARG AGENTBOX_CLAUDE_INSTALL=native',
    'ARG AGENTBOX_CLAUDE_INSTALL=npm',
  );
  if (flipped === original) {
    throw new Error(
      `could not enable npm Claude install for Daytona: 'ARG AGENTBOX_CLAUDE_INSTALL=native' ` +
        `not found in ${originalPath}. The Dockerfile.box drifted from the expected shape.`,
    );
  }
  const target = join(dirname(originalPath), '.agentbox-claude-npm.Dockerfile');
  writeFileSync(target, flipped);
  return target;
}
