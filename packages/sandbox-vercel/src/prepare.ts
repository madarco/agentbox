/**
 * `agentbox prepare --provider vercel` — bake the per-team Vercel base
 * snapshot. Vercel can't build an image from a Dockerfile, so (like hetzner)
 * we boot a fresh sandbox, run an installer, and snapshot the result. That
 * snapshot id is what every per-box `create` boots from.
 *
 * Flow:
 *   1. Resolve runtime assets + fingerprint the build context. Skip the bake
 *      when an up-to-date base snapshot already exists (unless --force).
 *   2. `Sandbox.create({ runtime: 'node24', persistent: false })` — fresh AL2023.
 *   3. `writeFiles` the assets (ctl bundle, helpers, baked configs, provision.sh).
 *   4. Run provision.sh as root, streaming output to the prepare log.
 *   5. Stage host agent static config (claude/codex/opencode) into the snapshot.
 *   6. `sandbox.snapshot({ expiration: 0 })` → the never-expiring base snapshot.
 *   7. Persist the snapshot id into ~/.agentbox/vercel-prepared.json.
 *   8. Delete the builder sandbox.
 *
 * Step 8 is safe: a Vercel snapshot is an independent, id-addressed resource
 * that survives its source sandbox's deletion (verified live — snapshot stays
 * `status: 'created'` and boots a fresh sandbox after the builder is deleted).
 * We delete it best-effort *after* the snapshot id is persisted, so a delete
 * failure only leaves a lingering sandbox for Vercel's reaper, never a broken
 * bake.
 */

import { readFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import type { AgentId, Provider } from '@agentbox/core';
import { UserFacingError } from '@agentbox/core';
import {
  agentSetArg,
  computeContextManifest,
  normalizeAgentSet,
  readCliStamp,
  renderInstallRecipe,
  renderPackageInstall,
  resolveAgentInstall,
  renderAgentSettingEnv,
  type AgentSettingsMap,
  resolveAgentSpec,
  variantFingerprint,
} from '@agentbox/sandbox-core';
import { type StageResult, stageAllAgentStatic } from '@agentbox/sandbox-cloud';
import { ensureVercelCredentials } from './credentials.js';
import {
  ensureFreshCredentials,
  resolveCredentials,
  Sandbox,
  Snapshot,
  type SandboxType,
} from './sdk.js';
import {
  preparedEntryFor,
  preparedStatePath,
  readPreparedState,
  writePreparedState,
} from './prepared-state.js';
import {
  findStagedCliRuntimeRoot,
  resolveRuntimeAssets,
  type ResolvedAsset,
} from './runtime-assets.js';

export interface PrepareVercelOptions {
  name?: string;
  hostWorkspace?: string;
  /** Force re-bake even when an up-to-date base snapshot is recorded. */
  force?: boolean;
  /** vCPUs for the builder sandbox (default 4 for a fast bake). */
  vcpus?: number;
  /** CLI runtime tree (set by the CLI to its dist neighbor). */
  cliRuntimeRoot?: string;
  /** Repo root for the dev fallback (defaults to a cwd-walk). */
  repoRoot?: string;
  /**
   * Every agent's declared settings (`AgentSyncSpec.settings`), keyed by agent
   * id. Selects an alternate install recipe where the agent declared one, and
   * is exported into its install shell as `AGENTBOX_AGENT_SETTING_*`.
   */
  agentSettings?: AgentSettingsMap;
  /**
   * Agents to bake in. Empty/omitted bakes the AGENTLESS base.
   *
   * A non-empty set bakes a DERIVED snapshot: boot the existing base, run only
   * those agents' install recipes, re-snapshot. The base already carries the
   * expensive layers (dnf packages, Chromium, the VNC stack), so re-running
   * provision.sh would rebuild all of it for one npm install.
   */
  agents?: string[];
  onLog?: (line: string) => void;
}

export interface PrepareVercelResult {
  snapshotName?: string;
}

const BUILDER_TIMEOUT_MS = 25 * 60_000;
const BOX_USER = 'vscode';
const SHELL = '/bin/bash';

/**
 * The `Sandbox.create` fields that select what the builder boots from.
 *
 * A base bake starts from the stock runtime; a derived bake boots the base
 * snapshot. The SDK's create params are a union (`sandbox.d.ts` CreateSandboxParams)
 * whose snapshot branch OMITS `runtime`, so passing both is a type error and
 * passing `runtime` alongside a snapshot source would be silently wrong. Kept as
 * a pure function so a unit test can assert the shape without the SDK.
 */
/** Single-quote a string for safe embedding inside a `bash -lc '<...>'`. */
function shellSingleQuote(str: string): string {
  return `'${str.replaceAll("'", `'\\''`)}'`;
}

export function buildBuilderSource(
  snapshotId: string | undefined,
): { runtime: 'node24' } | { source: { type: 'snapshot'; snapshotId: string } } {
  return snapshotId === undefined
    ? { runtime: 'node24' }
    : { source: { type: 'snapshot', snapshotId } };
}

export async function prepareVercel(opts: PrepareVercelOptions = {}): Promise<PrepareVercelResult> {
  await ensureVercelCredentials();
  await ensureFreshCredentials();
  const creds = resolveCredentials();
  const log = opts.onLog ?? (() => {});
  const progress = (s: string) => log(`prepare-vercel: ${s}`);

  const assets = resolveRuntimeAssets({
    cliRuntimeRoot: opts.cliRuntimeRoot ?? findStagedCliRuntimeRoot(),
    repoRoot: opts.repoRoot,
  });
  const agentSettings = opts.agentSettings ?? {};
  // Keep the per-file digests, not just the fold: a later `stale` verdict can
  // then name the files that changed instead of only reporting a moved hash.
  const contextManifest = await computeContextManifest(
    assets.map((a) => ({ rel: a.name, abs: a.localPath })),
  );
  const agents = normalizeAgentSet(opts.agents);
  const variantKey = agentSetArg(agents);
  const derived = agents.length > 0;
  const contextSha = variantFingerprint(contextManifest.contextSha256, { agentSettings, agents });

  const existing = readPreparedState();
  // A derived bake boots the agentless base, so that has to exist first.
  const baseEntry = preparedEntryFor(existing, '');
  if (derived && !baseEntry) {
    throw new UserFacingError(
      'no Vercel base snapshot to derive from - run `agentbox prepare --provider vercel` first, ' +
        'then re-run with --agents.',
    );
  }

  // Skip-fast: this variant's snapshot still on Vercel + matching fingerprint.
  const existingEntry = preparedEntryFor(existing, variantKey);
  if (!opts.force && existingEntry) {
    const stillThere = await snapshotExists(existingEntry.snapshotId, creds);
    if (stillThere && existingEntry.contextSha256 === contextSha) {
      progress(
        `${derived ? `${variantKey} snapshot` : 'base snapshot'} ${existingEntry.snapshotId} already exists (fingerprint ${contextSha.slice(0, 12)} matches); skipping (pass --force to rebuild)`,
      );
      return { snapshotName: existingEntry.snapshotId };
    }
    if (!stillThere) {
      progress(
        `recorded ${variantKey || 'base'} snapshot ${existingEntry.snapshotId} is gone on Vercel; rebuilding`,
      );
    } else {
      progress(
        `build context changed (was ${existingEntry.contextSha256?.slice(0, 12) ?? '<none>'}, now ${contextSha.slice(0, 12)}); rebuilding ${variantKey || 'base'} snapshot`,
      );
    }
  }

  progress(
    derived
      ? `creating builder sandbox from the base snapshot (${String(opts.vcpus ?? 4)} vcpus)`
      : `creating builder sandbox (node24, ${String(opts.vcpus ?? 4)} vcpus)`,
  );
  const sb = await Sandbox.create({
    ...buildBuilderSource(derived ? baseEntry!.snapshotId : undefined),
    resources: { vcpus: opts.vcpus ?? 4 },
    timeout: BUILDER_TIMEOUT_MS,
    tags: { agentbox: 'true', 'agentbox.role': 'prepare' },
    // NO `keepLastSnapshots`, and persistent:false. A derived builder boots FROM
    // the shared base, which Vercel then reports as its currentSnapshotId -- so a
    // retention window of 1 with the default `deleteEvicted: true` would evict
    // and DELETE the base the moment we snapshot, breaking every other box.
    // Setting no policy at all means no window exists. Asserted in a unit test.
    persistent: false,
    ...creds,
  });
  progress(`builder sandbox ${sb.name} up`);

  // 3. Upload assets. A derived bake needs none of them: the base snapshot
  // already carries every baked asset, and it runs only the agent recipes.
  if (!derived) {
    progress(`uploading ${String(assets.length)} runtime asset(s)`);
    await sb.writeFiles(
      await Promise.all(
        assets.map(async (a: ResolvedAsset) => ({
          path: a.remotePath,
          content: await readFile(a.localPath),
          mode: a.remoteMode,
        })),
      ),
    );
  }

  // 4. Install. A base bake runs provision.sh; a derived bake runs ONLY the
  // agent recipes -- the base already has the expensive layers (dnf packages,
  // Chromium, the VNC stack), and provision.sh trims its own inputs from /tmp
  // before the snapshot so it cannot be re-run anyway.
  if (derived) {
    // Same AGENT_SYNC_SPECS data the docker derived layer and
    // `ensureAgentInstalled` use, so a vercel-baked agent and a runtime-added
    // one are installed identically.
    for (const id of agents) {
      const spec = resolveAgentSpec(id);
      const agentInstall = resolveAgentInstall(spec.install, agentSettings[spec.id]);
      progress(`installing ${spec.id} into the derived snapshot`);
      const steps: string[] = [];
      if (agentInstall.packages && agentInstall.packages.length > 0) {
        // Vercel is Amazon Linux 2023, so this renders dnf, not apt-get. An
        // optional prerequisite (codex's bubblewrap) must not fail the bake --
        // the agent works without it, just degraded.
        const pkgLine = renderPackageInstall(agentInstall.packages);
        steps.push(
          agentInstall.packagesOptional
            ? `{ ${pkgLine} } || echo "prepare-vercel: optional prerequisites for ${spec.id} unavailable; continuing"`
            : pkgLine,
        );
      }
      const settingEnv = renderAgentSettingEnv(agentSettings[spec.id]);
      const recipe = settingEnv + renderInstallRecipe(agentInstall.recipe);
      // `runAs: 'box-user'` is load-bearing: the native installers write into
      // the INVOKING user's ~/.local/bin, so running them as root would put the
      // binary in /root and the box user would never see it.
      steps.push(
        agentInstall.runAs === 'box-user'
          ? `sudo -u ${BOX_USER} -H bash -lc ${shellSingleQuote(recipe)}`
          : recipe,
      );
      if (agentInstall.postInstall) steps.push(settingEnv + agentInstall.postInstall);
      steps.push(
        `sudo -u ${BOX_USER} -H bash -lc 'command -v ${spec.binary} >/dev/null' || ` +
          `{ echo "prepare-vercel: ${spec.id} not on PATH after install" >&2; exit 71; }`,
      );
      const res = await sb.runCommand({
        cmd: SHELL,
        args: ['-lc', steps.join(' && ')],
        sudo: true,
        stdout: lineSink((l) => log(`[${spec.id}] ${l}`)),
        stderr: lineSink((l) => log(`[${spec.id}] ${l}`)),
      });
      if (res.exitCode !== 0) {
        throw new Error(
          `vercel: installing ${spec.id} into the derived snapshot failed (exit ${String(res.exitCode)}).`,
        );
      }
    }
  } else {
    // No AGENTBOX_CLAUDE_INSTALL any more: the base installs no agents, so the
    // mode has nothing to select. It still folds into the fingerprint (above)
    // because the derived bake reads it, and the two tiers share one chain.
    progress('running provision.sh (this takes a few minutes)');
    const install = await sb.runCommand({
      cmd: SHELL,
      args: ['-lc', 'bash /tmp/agentbox-provision.sh 2>&1'],
      sudo: true,
      stdout: lineSink((l) => log(`[provision] ${l}`)),
      stderr: lineSink((l) => log(`[provision] ${l}`)),
    });
    if (install.exitCode !== 0) {
      throw new Error(
        `provision.sh failed on the builder sandbox (exit ${String(install.exitCode)})`,
      );
    }
    progress('provision.sh complete');
  }

  // 5. Stage host agent static config into the snapshot (best-effort).
  await stageAgentConfig(sb, opts.hostWorkspace, log, agents);

  // 6. Snapshot (never expires). NOTE: this STOPS the builder sandbox before
  // imaging (documented in the SDK; `snapshotting` is its own status), so the
  // guest is powered down and its page cache written back. That is why vercel
  // needs no pre-snapshot `sync` the way hetzner/digitalocean do -- those image
  // a running VM and silently lost freshly-written files without one.
  progress(`creating ${derived ? variantKey : 'base'} snapshot (expiration: never)`);
  const snap = await sb.snapshot({ expiration: 0 });
  progress(`snapshot created: ${snap.snapshotId}`);

  // 7. Persist.
  const cliStamp = readCliStamp();
  const state = readPreparedState();
  const superseded = preparedEntryFor(state, variantKey)?.snapshotId;
  const entry = {
    snapshotId: snap.snapshotId,
    contextSha256: contextSha,
    files: contextManifest.files,
    cliVersion: cliStamp.cliVersion,
    cliCommit: cliStamp.cliCommit,
    createdAt: new Date().toISOString(),
  };
  // Merge, never replace: each variant keeps its own record, so baking a codex
  // snapshot doesn't invalidate the claude one.
  state.variants = { ...state.variants, [variantKey]: entry };
  // `base` stays the AGENTLESS base, never the newest bake. Provider-generic
  // readers (freshness, bake sharing, prepared-custody) reach straight for
  // `base.contextSha256` and assume it describes the agentless context; point
  // that at a codex snapshot and they report a permanent false "stale".
  if (!derived) state.base = entry;
  writePreparedState(state);
  progress(`wrote ${preparedStatePath()}`);

  // Reap the snapshot this bake replaces -- ONLY after the new one is recorded,
  // so a failed bake never leaves the user with no base, and only for this exact
  // variant, so a codex re-bake can't delete the claude snapshot.
  if (superseded !== undefined && superseded !== snap.snapshotId) {
    progress(`removing superseded snapshot ${superseded}`);
    try {
      const old = await Snapshot.get({ snapshotId: superseded, ...creds });
      await old.delete();
    } catch (err) {
      progress(
        `could not delete superseded snapshot ${superseded} (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 8. Delete the builder. The snapshot is an independent resource that
  // survives this (verified live), and its id is already persisted above, so
  // this is best-effort: a failure just leaves the sandbox for Vercel's reaper.
  progress('deleting builder sandbox');
  try {
    await sb.delete();
    progress('builder sandbox deleted');
  } catch (err) {
    progress(
      `builder delete failed (left for Vercel reaper): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  progress(`prepare complete — ${derived ? variantKey : 'base'} snapshot ${snap.snapshotId}`);
  return { snapshotName: snap.snapshotId };
}

async function snapshotExists(
  snapshotId: string,
  creds: Partial<{ token: string; teamId: string; projectId: string }>,
): Promise<boolean> {
  try {
    const snap = await Snapshot.get({ snapshotId, ...creds });
    // `Snapshot.get` resolves even for a deleted/failed snapshot (status field),
    // so a bare "didn't throw" wrongly skip-passes a tombstone. Only a 'created'
    // snapshot is bootable — anything else means rebuild.
    return snap.status === 'created';
  } catch {
    return false;
  }
}

async function stageAgentConfig(
  sb: SandboxType,
  hostWorkspace: string | undefined,
  log: (line: string) => void,
  agents: readonly string[] = [],
): Promise<void> {
  const progress = (s: string) => log(`prepare-vercel: ${s}`);
  progress('staging host agent static config');
  // Only the agents this snapshot is for: staging every agent's host config into
  // a claude-only snapshot would put codex's and opencode's settings in a box
  // that has neither binary. `~/.agents` is always staged -- shared skills, not
  // an agent's auth.
  const wantsAll = agents.length === 0;
  const stagings: Array<{
    kind: AgentId | 'agents';
    tar: StageResult;
    dest: string;
  }> = [];
  try {
    const stages = await stageAllAgentStatic({
      hostWorkspace,
      agents: wantsAll ? undefined : agents,
    });
    for (const s of stages) {
      for (const w of s.staged.warnings) progress(w);
      if (s.staged.tarballPath) stagings.push({ kind: s.kind, tar: s.staged, dest: s.extractDir });
      else await s.staged.cleanup();
    }

    for (const s of stagings) {
      const remote = `/tmp/agentbox-${s.kind}-static.tar.gz`;
      progress(`uploading ${s.kind} static config`);
      await sb.writeFiles([{ path: remote, content: await readFile(s.tar.tarballPath as string) }]);
      // Extract as vscode so files land owned by the box user. `mkdir -p` is
      // load-bearing now: the agentless base no longer pre-creates these dirs
      // (that moved onto each agent's postInstall), so on a base bake they may
      // not exist yet.
      const extract =
        `sudo -u vscode mkdir -p ${s.dest} && ` +
        `sudo -u vscode tar -xzf ${remote} -C ${s.dest} --no-same-permissions --no-same-owner -m && ` +
        `rm -f ${remote}`;
      const r = await sb.runCommand({ cmd: SHELL, args: ['-lc', extract], sudo: true });
      if (r.exitCode !== 0) {
        progress(`WARN: ${s.kind} static extract failed (exit ${String(r.exitCode)}) — continuing`);
      } else {
        progress(`baked ${s.kind} static config into snapshot`);
      }
    }
  } finally {
    for (const s of stagings) await s.tar.cleanup();
  }
}

/**
 * Adapt a line-callback to the `Writable` the SDK's `runCommand` streams into.
 * Buffers partial lines so each `onLine` gets a complete line.
 */
function lineSink(onLine: (line: string) => void): Writable {
  let buf = '';
  return new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      cb();
    },
    final(cb: () => void) {
      if (buf.length > 0) onLine(buf);
      cb();
    },
  });
}

/** Provider-level binding used by the CLI's `prepare` command. */
export const prepareVercelProvider: NonNullable<Provider['prepare']> = (req) =>
  prepareVercel({
    name: req.name,
    hostWorkspace: req.hostWorkspace ?? process.cwd(),
    force: req.force,
    ...(req.agentSettings ? { agentSettings: req.agentSettings } : {}),
    // Empty/absent bakes the agentless base; a set bakes a derived snapshot.
    ...(req.agents ? { agents: req.agents } : {}),
    onLog: req.onLog,
  });
