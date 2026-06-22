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

import { Image } from '@daytonaio/sdk';
import type { PrepareOptions, PrepareResult } from '@agentbox/core';
import {
  stageClaudeStaticForUpload,
  stageCodexStaticForUpload,
  stageAgentsStaticForUpload,
  stageOpencodeStaticForUpload,
  type StageResult,
} from '@agentbox/sandbox-cloud';
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

interface AgentStage {
  kind: 'claude' | 'codex' | 'opencode' | 'agents';
  /** Path inside the image build that the tarball is uploaded to. */
  remoteTar: string;
  /** Path the image build extracts the tarball into. */
  extractDir: string;
  staged: StageResult;
}

/**
 * Stage the three agents' static tarballs in parallel. Each `StageResult`'s
 * `cleanup()` must be called by the caller, after the image build picks the
 * file up.
 */
async function stageAllAgentStatic(opts: { hostWorkspace?: string }): Promise<AgentStage[]> {
  const [claudeStaged, codexStaged, opencodeStaged, agentsStaged] = await Promise.all([
    stageClaudeStaticForUpload({ hostWorkspace: opts.hostWorkspace }),
    stageCodexStaticForUpload(),
    stageOpencodeStaticForUpload(),
    stageAgentsStaticForUpload(),
  ]);
  return [
    {
      kind: 'claude',
      remoteTar: '/tmp/agentbox-seed-claude.tar.gz',
      extractDir: '/home/vscode/.claude',
      staged: claudeStaged,
    },
    {
      kind: 'codex',
      remoteTar: '/tmp/agentbox-seed-codex.tar.gz',
      extractDir: '/home/vscode/.codex',
      staged: codexStaged,
    },
    {
      kind: 'opencode',
      remoteTar: '/tmp/agentbox-seed-opencode.tar.gz',
      extractDir: '/home/vscode/.local/share/opencode',
      staged: opencodeStaged,
    },
    {
      kind: 'agents',
      remoteTar: '/tmp/agentbox-seed-agents.tar.gz',
      extractDir: '/home/vscode/.agents',
      staged: agentsStaged,
    },
  ];
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
  const fingerprint = await computeDaytonaContextFingerprint();
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

  try {
    let image: Image = Image.fromDockerfile(ctx.dockerfile);

    // Overlay the daytona-specific /etc/claude-code/CLAUDE.md on top of the
    // docker-shaped one baked by Dockerfile.box. Daytona boxes have no host
    // .git/ bind-mount, so the in-box hint needs daytona-specific git wording.
    image = image.addLocalFile(daytonaClaudeMd, '/tmp/agentbox-custom-CLAUDE.md');
    const extractCmds: string[] = [
      'install -m 0644 /tmp/agentbox-custom-CLAUDE.md /etc/claude-code/CLAUDE.md',
      'rm -f /tmp/agentbox-custom-CLAUDE.md',
    ];

    // For each agent whose stage produced a tarball, add the file to the
    // image build context and append a single tar-extract + chown.
    const usable = stages.filter((s) => s.staged.tarballPath !== null);
    for (const s of usable) {
      image = image.addLocalFile(s.staged.tarballPath as string, s.remoteTar);
      extractCmds.push(`mkdir -p ${s.extractDir}`);
      extractCmds.push(`tar -xzf ${s.remoteTar} -C ${s.extractDir}`);
    }
    if (usable.length > 0) {
      // One final pass: own the extracted trees as the box user, then drop the
      // staging tarballs (no point shipping them twice in the image layer).
      extractCmds.push(
        'chown -R vscode:vscode /home/vscode/.claude /home/vscode/.codex /home/vscode/.local',
      );
      // ~/.agents is only present when the host had one (skills dir); guard it.
      extractCmds.push(
        '[ -d /home/vscode/.agents ] && chown -R vscode:vscode /home/vscode/.agents || true',
      );
      extractCmds.push('rm -f /tmp/agentbox-seed-*.tar.gz');
    }
    // Dockerfile.box ends with `USER vscode`. Switch to root for the
    // install/tar/chown/rm pass — COPYed files are root-owned in /tmp (sticky
    // bit), chown -R on /home/vscode/.* only works as root, and
    // /etc/claude-code is root-owned. Switch back to vscode so the image
    // keeps its default-user invariant.
    image = image
      .dockerfileCommands(['USER root'])
      .runCommands(...extractCmds)
      .dockerfileCommands(['USER vscode']);

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
  }
}
