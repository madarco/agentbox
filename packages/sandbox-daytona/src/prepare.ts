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
import { Image } from '@daytonaio/sdk';
import type { PrepareOptions, PrepareResult } from '@agentbox/core';
import {
  claudeInstallFingerprint,
  stageAllAgentStatic,
  type AgentStaticStage,
} from '@agentbox/sandbox-core';
import { getClient } from './backend.js';
import { resolveDaytonaCustomClaudeMd, resolveDockerfileContext } from './dockerfile-context.js';
import { ensureDaytonaEnvLoaded } from './env-loader.js';
import {
  computeDaytonaContextFingerprint,
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
function defaultSnapshotName(fingerprint: string | null): string {
  if (fingerprint) return `agentbox-base-${fingerprint.slice(0, 12)}`;
  return `agentbox-base-${Math.floor(Date.now() / 1000).toString()}`;
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
  const snapshotName =
    opts.name ?? defaultSnapshotName(fingerprint?.contextSha256 ?? null);

  const prepared = readPreparedDaytonaState();
  if (
    !opts.force &&
    fingerprint &&
    preparedMatches(prepared, fingerprint.contextSha256)
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
    log(
      `daytona build context changed (was ${prepared.base.contextSha256.slice(0, 12)}, ` +
        `now ${fingerprint.contextSha256.slice(0, 12)}); rebuilding snapshot`,
    );
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

    const client = getClient();
    log(`creating Daytona snapshot '${snapshotName}'…`);
    const snapshot = await client.snapshot.create(
      { name: snapshotName, image },
      {
        onLogs: (chunk: string) => log(String(chunk).split('\n').filter(Boolean).join(' ')),
      },
    );
    log(`snapshot '${snapshot.name}' is ${snapshot.state ?? 'created'}`);
    if (fingerprint) {
      writePreparedDaytonaState({
        snapshotName: snapshot.name ?? snapshotName,
        contextSha256: fingerprint.contextSha256,
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
