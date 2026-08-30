/**
 * `agentbox prepare --provider digitalocean` — bake the per-account DigitalOcean
 * base snapshot. DigitalOcean (like Hetzner) cannot build an image from a
 * Dockerfile, so we boot a throwaway Droplet, run `install-box.sh` over ssh,
 * snapshot it, and record the snapshot id.
 *
 * Flow:
 *   1. Mint an ephemeral SSH keypair under ~/.agentbox/digitalocean/prepare-<ts>/.
 *   2. Detect the host's egress IP and create a firewall locked to it,
 *      bound to a per-prepare tag.
 *   3. Create a temp Droplet (Ubuntu 24.04, `s-2vcpu-4gb` default) with
 *      cloud-init injecting the pubkey for `root` + the prepare tag.
 *   4. Poll until the droplet is active + sshd comes up.
 *   5. scp the runtime assets into /tmp.
 *   6. Run `bash /tmp/agentbox-install.sh` over ssh; stream stdout to the
 *      prepare log via `onLog`.
 *   7. `snapshot` action on the Droplet; poll the action until completed,
 *      then resolve the snapshot id by name.
 *   8. Delete the Droplet + firewall.
 *   9. Persist the snapshot id into `~/.agentbox/digitalocean-prepared.json`.
 *
 * Failure-mode discipline: each major step is wrapped in try/catch so the
 * temp Droplet + firewall are *always* cleaned up on failure (the user must
 * never end up with a forgotten paid Droplet due to a prepare error).
 */

import { join } from 'node:path';
import type { AgentId, Provider } from '@agentbox/core';
import { UserFacingError } from '@agentbox/core';
import {
  agentSetArg,
  computeContextManifest,
  normalizeAgentSet,
  readCliStamp,
  renderPackageInstall,
  renderInstallRecipe,
  resolveAgentInstall,
  resolveAgentSpec,
  variantFingerprint,
} from '@agentbox/sandbox-core';
import {
  stageClaudeStaticForUpload,
  stageCodexStaticForUpload,
  stageAgentsStaticForUpload,
  stageOpencodeStaticForUpload,
  type StageResult,
} from '@agentbox/sandbox-cloud';
import { loadEffectiveConfig } from '@agentbox/config';
import { ensureDigitalOceanCredentials } from './credentials.js';
import { detectEgressIp } from './egress-ip.js';
import { createPerBoxFirewall, deletePerBoxFirewall, normalizeSourceCidr } from './firewall.js';
import { resolveProjectChoice, validateSizeChoice } from './preflight.js';
import { makeDigitalOceanClient, type DigitalOceanClient } from './client.js';
import { generateDerivedPrepareCloudInit, generatePrepareCloudInit } from './cloud-init.js';
import {
  preparedEntryFor,
  preparedStatePath,
  readPreparedState,
  writePreparedState,
} from './prepared-state.js';
import { pollUntil } from './poll.js';
import {
  findStagedCliRuntimeRoot,
  resolveRuntimeAssets,
  type ResolvedAsset,
} from './runtime-assets.js';
import { mintPrepareKey } from './ssh-key.js';
import { scpUpload, sshExec, waitForSsh, type SshTargetArgs } from './ssh-cli.js';

export interface PrepareDigitalOceanOptions {
  name?: string;
  hostWorkspace?: string;
  /** Force re-bake even when `~/.agentbox/digitalocean-prepared.json` has a usable base. */
  force?: boolean;
  /** DigitalOcean region slug (defaults to `nyc3`). */
  region?: string;
  /** Droplet size slug (defaults to `s-2vcpu-4gb` — 2 vCPU / 4 GB / 80 GB). */
  size?: string;
  /**
   * DigitalOcean Project (name or id) for the temp bake Droplet. Defaults to
   * `box.digitaloceanProject`, so the bake doesn't show up in the account's
   * default project while every box lands somewhere else.
   */
  project?: string;
  /**
   * How the bake installs Claude Code: `native` (default) or `npm`. Threaded
   * into install-box.sh via `AGENTBOX_CLAUDE_INSTALL`. The `npm` escape hatch
   * is for cloud egress IPs whose CDN the native installer 403s. Bake-time
   * only; part of the context fingerprint (a change re-bakes).
   */
  claudeInstall?: 'native' | 'npm';
  /**
   * Agents to bake in. Empty/omitted bakes the AGENTLESS base.
   *
   * A non-empty set bakes a DERIVED snapshot: boot the existing base, run only
   * those agents' install recipes, re-snapshot. That is why it can't just be
   * another env var for install-box.sh -- the base snapshot already has the
   * expensive layers, and re-running the whole script would rebuild them.
   */
  agents?: string[];
  /**
   * Override the firewall source CIDR. Defaults to auto-detected egress IP
   * via `detectEgressIp()` (with `/32` appended). Pass `'0.0.0.0/0'` for the
   * explicit-open opt-in. A bare IP gets `/32` appended automatically.
   */
  firewallSource?: string;
  /** CLI runtime tree (set by the CLI to its dist neighbor). */
  cliRuntimeRoot?: string;
  /** Repo root for the dev fallback (defaults to `process.cwd()` walk). */
  repoRoot?: string;
  onLog?: (line: string) => void;
}

export interface PrepareDigitalOceanResult {
  snapshotName?: string;
  /** DigitalOcean snapshot id (numeric) — also recorded in digitalocean-prepared.json. */
  imageId?: number;
}

const TEMP_SIZE_DEFAULT = 's-2vcpu-4gb';
const TEMP_REGION_DEFAULT = 'nyc3';
const STOCK_IMAGE_SLUG = 'ubuntu-24-04-x64';
const PREPARE_SSH_DEADLINE_MS = 5 * 60_000;
const PROVISION_DROPLET_DEADLINE_MS = 5 * 60_000;
const INSTALL_SCRIPT_TIMEOUT_MS = 30 * 60_000;
const SNAPSHOT_DEADLINE_MS = 30 * 60_000;

/** Single-quote a string for safe embedding inside a `bash -lc '<...>'`. */
function shellSingleQuote(str: string): string {
  return `'${str.replaceAll("'", `'\\''`)}'`;
}

/** Look up a recorded base snapshot (numeric id) in the live snapshot list. */
async function snapshotStillExists(client: DigitalOceanClient, imageId: number): Promise<boolean> {
  try {
    const snaps = await client.listSnapshots();
    return snaps.some((s) => s.id === String(imageId));
  } catch {
    // If we can't reach the API, don't force a rebuild on a transient error.
    return true;
  }
}

/**
 * Bake the per-account DigitalOcean base snapshot. Resolves only after the
 * snapshot completes and the temp Droplet + firewall are gone. Persists
 * `{base.imageId, base.description, base.createdAt, base.contextSha256, …}`
 * into `~/.agentbox/digitalocean-prepared.json`.
 */
export async function prepareDigitalOcean(
  opts: PrepareDigitalOceanOptions = {},
): Promise<PrepareDigitalOceanResult> {
  await ensureDigitalOceanCredentials();
  const client = makeDigitalOceanClient();
  const log = opts.onLog ?? (() => {});
  const progress = (step: string) => log(`prepare-digitalocean: ${step}`);

  // Skip-fast: if a base snapshot is already recorded *and* still on
  // DigitalOcean *and* the build-context fingerprint hasn't changed *and*
  // --force was not passed, return the existing record.
  const existingState = readPreparedState();
  const assets = resolveRuntimeAssets({
    cliRuntimeRoot: opts.cliRuntimeRoot ?? findStagedCliRuntimeRoot(),
    repoRoot: opts.repoRoot,
  });
  const claudeInstall = opts.claudeInstall ?? 'native';
  // Fold the Claude install mode into the fingerprint so switching native<->npm
  // re-bakes even though the staged asset files are identical (matches Hetzner).
  // Keep the per-file digests, not just the fold: a later `stale` verdict can
  // then name the files that changed instead of only reporting a moved hash.
  const contextManifest = await computeContextManifest(
    assets.map((a) => ({ rel: a.name, abs: a.localPath })),
  );
  const agents = normalizeAgentSet(opts.agents);
  const variantKey = agentSetArg(agents);
  const derived = agents.length > 0;
  const contextSha = variantFingerprint(contextManifest.contextSha256, { claudeInstall, agents });

  // A derived bake boots the agentless base, so that has to exist first.
  const baseEntry = preparedEntryFor(existingState, '');
  if (derived && !baseEntry) {
    throw new UserFacingError(
      'no DigitalOcean base snapshot to derive from - run `agentbox prepare --provider digitalocean` first, ' +
        'then re-run with --agents.',
    );
  }

  const existingEntry = preparedEntryFor(existingState, variantKey);
  if (!opts.force && existingEntry) {
    const remote = await snapshotStillExists(client, existingEntry.imageId);
    if (remote && existingEntry.contextSha256 === contextSha) {
      progress(
        `${derived ? `${variantKey} snapshot` : 'base snapshot'} ${String(existingEntry.imageId)} already exists (fingerprint ${contextSha.slice(0, 12)} matches); skipping rebuild (pass --force to override)`,
      );
      return {
        snapshotName: existingEntry.description,
        imageId: existingEntry.imageId,
      };
    }
    if (!remote) {
      progress(
        `recorded ${variantKey || 'base'} snapshot ${String(existingEntry.imageId)} is gone on DigitalOcean; rebuilding`,
      );
    } else {
      progress(
        `build context changed (was ${existingEntry.contextSha256?.slice(0, 12) ?? '<none>'}, now ${contextSha.slice(0, 12)}); rebuilding ${variantKey || 'base'} snapshot`,
      );
    }
  }

  // 1. Mint ephemeral key.
  progress('minting ephemeral ssh key');
  const key = await mintPrepareKey();
  let firewallId: string | null = null;
  let dropletId: number | null = null;
  // Hoisted so the failure-cleanup catch can delete the tag it minted.
  const stamp = Date.now().toString(36);
  const prepareTag = `agentbox-prepare-${stamp}`;
  try {
    progress('detecting host egress IP');
    const source = opts.firewallSource
      ? normalizeSourceCidr(opts.firewallSource)
      : `${await detectEgressIp({ onLog: log })}/32`;

    // 2. Create per-prepare firewall, bound to a unique tag.
    const firewallName = `agentbox-prepare-${stamp}`;
    progress(`creating firewall ${firewallName} (source ${source})`);
    const firewall = await createPerBoxFirewall(client, {
      name: firewallName,
      sources: [source],
      tag: prepareTag,
    });
    firewallId = firewall.id;

    // 3. Create temp Droplet (tagged so the firewall applies at boot).
    const dropletName = `agentbox-prepare-${stamp}`;
    const cloudInit = derived
      ? generateDerivedPrepareCloudInit({ sshPubkey: key.publicKey })
      : generatePrepareCloudInit({ sshPubkey: key.publicKey });
    const size = opts.size ?? TEMP_SIZE_DEFAULT;
    let region = opts.region ?? TEMP_REGION_DEFAULT;
    if (derived) {
      // A derived bake boots a snapshot, so the temp Droplet must have a disk
      // at least as large as the base image's, and must sit in a region the
      // snapshot was replicated to -- a DO snapshot only boots where it is
      // listed. Neither is checked by the plain base bake (it boots a stock
      // slug, which DO sizes and places itself).
      const baseSnapshot = await client.getSnapshot(String(baseEntry?.imageId)).catch(() => null);
      if (baseSnapshot && !baseSnapshot.regions.includes(region)) {
        const fallback = baseSnapshot.regions[0];
        if (!fallback) {
          throw new UserFacingError(
            `the DigitalOcean base snapshot ${String(baseEntry?.imageId)} is not available in any region, ` +
              'so no derived bake can boot it. Re-run `agentbox prepare --provider digitalocean --force`.',
          );
        }
        progress(
          `base snapshot is not in ${region}; baking the derived snapshot in ${fallback} instead ` +
            `(available: ${baseSnapshot.regions.join(', ')})`,
        );
        region = fallback;
      }
      validateSizeChoice({ size, region }, await client.listSizes(), baseSnapshot);
    }
    progress(`creating temp Droplet ${dropletName} (${size} / ${region})`);
    const created = await client.createDroplet({
      name: dropletName,
      region,
      size,
      // A derived bake boots the agentless base snapshot; the plain base bake
      // starts from DigitalOcean's stock image. `image` accepts a numeric
      // snapshot id -- the box path does exactly this (backend.ts resolveImageRef).
      image: derived ? (baseEntry?.imageId ?? STOCK_IMAGE_SLUG) : STOCK_IMAGE_SLUG,
      user_data: cloudInit,
      tags: [prepareTag, 'agentbox', 'agentbox-prepare'],
      ipv6: false,
    });
    dropletId = created.droplet.id;

    // 3b. Place the bake Droplet in the same DO Project as the boxes, so it doesn't
    // surface in the account's default project for the 5-30 min it lives. Wholly
    // best-effort: a bake is expensive, and neither a project typo nor an API blip
    // is worth failing one over — the create path reports a bad project loudly.
    // Resolve config against the host workspace, NOT process.cwd(): a bake driven
    // by the hub's queued worker runs from the daemon's directory, which is not the
    // repo — so cwd would miss a per-repo `box.digitaloceanProject` and quietly bake
    // in the wrong project.
    const wantedProject = (
      opts.project ??
      (await loadEffectiveConfig(opts.hostWorkspace ?? process.cwd())).effective.box
        .digitaloceanProject
    ).trim();
    if (wantedProject.length > 0) {
      try {
        const projectId = resolveProjectChoice(wantedProject, await client.listProjects());
        await client.assignProjectResources(projectId, [`do:droplet:${String(dropletId)}`]);
        progress(`bake droplet assigned to project ${wantedProject}`);
      } catch (assignErr) {
        progress(
          `WARN — could not assign the bake droplet to project ${wantedProject} (continuing): ` +
            `${assignErr instanceof Error ? assignErr.message : String(assignErr)}`,
        );
      }
    }

    // 4. Wait for the droplet to become active + expose a public IPv4, then ssh.
    progress(`droplet ${String(dropletId)} created; waiting for it to boot`);
    const droplet = await pollUntil(
      `droplet ${String(dropletId)} active`,
      async () => {
        const d = await client.getDroplet(dropletId as number);
        const ip = d?.networks.v4.find((n) => n.type === 'public')?.ip_address;
        return d && d.status === 'active' && ip ? { d, ip } : null;
      },
      {
        deadlineMs: PROVISION_DROPLET_DEADLINE_MS,
        intervalMs: 3_000,
        maxIntervalMs: 10_000,
        onPoll: (l) => log(`prepare-digitalocean: ${l}`),
      },
    );
    const ip = droplet.ip;

    progress(`waiting for ssh on ${ip} (deadline ${String(PREPARE_SSH_DEADLINE_MS / 1000)}s)`);
    const sshTarget: SshTargetArgs = {
      host: ip,
      // A derived bake boots the base snapshot, whose sshd drop-in already has
      // `PermitRootLogin no` -- see generateDerivedPrepareCloudInit.
      user: derived ? 'vscode' : 'root',
      identity: key.privatePath,
      knownHosts: join(key.dir, 'known_hosts'),
    };
    const up = await waitForSsh(sshTarget, PREPARE_SSH_DEADLINE_MS);
    if (!up) {
      throw new Error(
        `digitalocean: ssh on ${ip} did not come up within ${String(PREPARE_SSH_DEADLINE_MS / 1000)}s`,
      );
    }
    progress(derived ? 'ssh up' : "ssh up — scp'ing runtime assets");

    // 5. scp every asset into /tmp/ **sequentially** (parallel uploads through
    // fresh ssh connections trip sshd's MaxStartups on a freshly-booted VPS).
    // A derived bake needs none of them: the base snapshot already carries
    // every baked asset, and it runs only the agent recipes.
    if (!derived) {
      for (const asset of assets) {
        const remote = `/tmp/${asset.remoteBasename}`;
        log(`prepare-digitalocean: scp ${asset.name} -> ${remote}`);
        await scpUpload(sshTarget, asset.localPath, remote);
        if (asset.remoteMode !== undefined) {
          const modeOctal = asset.remoteMode.toString(8);
          await sshExec(sshTarget, `chmod ${modeOctal} ${remote}`);
        }
      }
    }

    // 6. Install. A base bake runs install-box.sh; a derived bake runs ONLY the
    // agent recipes -- the base snapshot already carries the expensive layers,
    // and install-box.sh can't be re-run anyway (its own trim step deletes it
    // from /tmp before the snapshot).
    if (derived) {
      // The recipes come from the same AGENT_SYNC_SPECS data the docker derived
      // layer and `ensureAgentInstalled` use, so a DigitalOcean-baked agent and
      // a runtime-added one are installed identically.
      for (const id of agents) {
        const spec = resolveAgentSpec(id);
        const install = resolveAgentInstall(spec.install, claudeInstall);
        progress(`installing ${spec.id} into the derived snapshot`);
        const steps: string[] = [];
        if (install.packages && install.packages.length > 0)
          steps.push(renderPackageInstall(install.packages));
        const recipe = renderInstallRecipe(install.recipe);
        // `runAs: 'box-user'` is load-bearing: the native installers write into
        // the INVOKING user's ~/.local/bin, so running them as root would put
        // the binary in /root and the box user would never see it.
        steps.push(
          install.runAs === 'box-user'
            ? `sudo -u vscode -H bash -lc ${shellSingleQuote(recipe)}`
            : recipe,
        );
        if (install.postInstall) steps.push(install.postInstall);
        steps.push(
          `sudo -u vscode -H bash -lc 'command -v ${spec.binary} >/dev/null' || ` +
            `{ echo "prepare-digitalocean: ${spec.id} not on PATH after install" >&2; exit 71; }`,
        );
        const res = await sshExec(
          sshTarget,
          `sudo bash -lc ${shellSingleQuote(steps.join(' && '))}`,
          {
            timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS,
            onLine: (line) => log(`[${spec.id}] ${line}`),
          },
        );
        if (res.exitCode !== 0) {
          throw new Error(
            `digitalocean: installing ${spec.id} into the derived snapshot failed (exit ${String(res.exitCode)}).`,
          );
        }
      }
    } else {
      // No AGENTBOX_CLAUDE_INSTALL here any more: the base installs no agents,
      // so the mode has nothing to select. It still folds into the fingerprint
      // (above) because the derived bake reads it, and the two tiers share one
      // fingerprint chain.
      progress('running install-box.sh on temp Droplet (this takes ~5-15 min)');
      const installRes = await sshExec(
        sshTarget,
        `sudo mkdir -p /var/log/agentbox && set -o pipefail && bash -x /tmp/agentbox-install.sh 2>&1 | sudo tee /var/log/agentbox/install.log`,
        {
          timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS,
          onLine: (line) => log(`[install] ${line}`),
        },
      );
      if (installRes.exitCode !== 0) {
        throw new Error(
          `install-box.sh failed on temp Droplet (exit ${String(installRes.exitCode)})\n` +
            `Last stderr: ${installRes.stderr.slice(-500) || '(empty)'}\n` +
            `The full install trace was streamed to the prepare log above (the '[install] …' lines; ` +
            `also in ~/.agentbox/logs/latest.log). No snapshot was created and the temp Droplet is being ` +
            `deleted, so the in-box /var/log/agentbox/install.log does not survive this failure.`,
        );
      }
    }
    progress('install script complete');

    // 6b. Stage host agent static config (~/.claude, ~/.codex, opencode,
    // ~/.agents) into /home/vscode/ so in-box agents boot with plugins/skills/
    // settings already present. Mirrors the Hetzner/Daytona bake step.
    progress('staging host agent static config');
    // Only the agents this snapshot is for: staging every agent's host config
    // into a claude-only snapshot would put codex's and opencode's settings in
    // a box that has neither binary. `~/.agents` is always staged -- shared
    // skills, not an agent's auth.
    const wantsAgent = (id: string): boolean => agents.length === 0 || agents.includes(id);
    const stagings: Array<{
      kind: AgentId | 'agents';
      tar: StageResult;
      dest: string;
    }> = [];
    try {
      const claudeTar = await stageClaudeStaticForUpload({ hostWorkspace: opts.hostWorkspace });
      for (const w of claudeTar.warnings) log(`prepare-digitalocean: ${w}`);
      if (claudeTar.tarballPath && wantsAgent('claude'))
        stagings.push({ kind: 'claude', tar: claudeTar, dest: '/home/vscode/.claude' });
      else await claudeTar.cleanup();

      const codexTar = await stageCodexStaticForUpload();
      for (const w of codexTar.warnings) log(`prepare-digitalocean: ${w}`);
      if (codexTar.tarballPath && wantsAgent('codex'))
        stagings.push({ kind: 'codex', tar: codexTar, dest: '/home/vscode/.codex' });
      else await codexTar.cleanup();

      const opencodeTar = await stageOpencodeStaticForUpload();
      for (const w of opencodeTar.warnings) log(`prepare-digitalocean: ${w}`);
      if (opencodeTar.tarballPath && wantsAgent('opencode'))
        stagings.push({
          kind: 'opencode',
          tar: opencodeTar,
          dest: '/home/vscode/.local/share/opencode',
        });
      else await opencodeTar.cleanup();

      const agentsTar = await stageAgentsStaticForUpload();
      for (const w of agentsTar.warnings) log(`prepare-digitalocean: ${w}`);
      if (agentsTar.tarballPath)
        stagings.push({ kind: 'agents', tar: agentsTar, dest: '/home/vscode/.agents' });
      else await agentsTar.cleanup();

      for (const s of stagings) {
        const remote = `/tmp/agentbox-${s.kind}-static.tar.gz`;
        log(`prepare-digitalocean: scp ${s.kind} static (${s.tar.tarballPath}) -> ${remote}`);
        await scpUpload(sshTarget, s.tar.tarballPath as string, remote);
        const extractCmd =
          `sudo -u vscode mkdir -p ${s.dest} && ` +
          `sudo -u vscode tar -xzf ${remote} -C ${s.dest} --no-same-permissions --no-same-owner -m && ` +
          `rm -f ${remote}`;
        const r = await sshExec(sshTarget, extractCmd, {
          onLine: (line) => log(`[stage:${s.kind}] ${line}`),
        });
        if (r.exitCode !== 0) {
          throw new Error(
            `prepare-digitalocean: ${s.kind} static extract failed (exit ${String(r.exitCode)}): ${r.stderr.slice(-300)}`,
          );
        }
        progress(`baked ${s.kind} static config into snapshot`);
      }
    } finally {
      for (const s of stagings) await s.tar.cleanup();
    }

    // Flush the page cache before snapshotting. Both providers image a LIVE
    // machine, so anything still buffered is simply absent from the resulting
    // snapshot -- silently, because the writes themselves succeeded. The static
    // config stage right above writes tens of MB and then we snapshot within
    // milliseconds, which lost every staged skill on a live derived bake while
    // `tar` reported exit 0 and the bake reported success.
    progress('flushing the page cache before snapshot');
    const doSync = await sshExec(sshTarget, 'sudo sync && sudo sync', {
      timeoutMs: 120_000,
    });
    if (doSync.exitCode !== 0) {
      throw new Error(
        `digitalocean: sync before snapshot failed (exit ${String(doSync.exitCode)}); ` +
          'refusing to snapshot a Droplet whose writes may not be on disk.',
      );
    }

    // 7. Snapshot the droplet (async action), then resolve the snapshot id by
    // name. DigitalOcean supports live snapshots, so we don't power off.
    // The name is the ONLY metadata a DO snapshot carries -- it is how the id is
    // recovered after the async action below, and how a checkpoint is resolved at
    // create. So a variant MUST get its own name, or the by-name lookup goes
    // ambiguous the moment a second variant exists.
    const description =
      opts.name ?? `agentbox-${derived ? variantKey.replaceAll(',', '-') : 'base'}-${stamp}`;
    progress(`creating snapshot '${description}' from droplet ${String(dropletId)}`);
    const action = await client.snapshotDroplet(dropletId, description);
    progress(`snapshot action ${String(action.id)} requested; polling until complete`);
    await pollUntil(
      `snapshot action ${String(action.id)}`,
      async () => {
        const a = await client.getAction(action.id);
        if (!a) return null;
        if (a.status === 'errored') {
          throw new Error(`digitalocean: snapshot action ${String(action.id)} errored`);
        }
        return a.status === 'completed' ? a : null;
      },
      {
        deadlineMs: SNAPSHOT_DEADLINE_MS,
        intervalMs: 3_000,
        maxIntervalMs: 10_000,
        onPoll: (l) => log(`prepare-digitalocean: ${l}`),
      },
    );
    const snap = (await client.listSnapshots()).find((s) => s.name === description);
    if (!snap) {
      throw new Error(
        `digitalocean: snapshot '${description}' completed but was not found in the snapshot list`,
      );
    }
    const snapshotId = Number.parseInt(snap.id, 10);

    // 8. Persist before tearing down — if cleanup fails we still know about
    // the new snapshot.
    progress('persisting digitalocean-prepared.json');
    const state = readPreparedState();
    const cliStamp = readCliStamp();
    const superseded = preparedEntryFor(state, variantKey)?.imageId;
    const entry = {
      imageId: snapshotId,
      description,
      createdAt: new Date().toISOString(),
      contextSha256: contextSha,
      files: contextManifest.files,
      cliVersion: cliStamp.cliVersion,
      cliCommit: cliStamp.cliCommit,
    };
    // Merge, never replace: each variant keeps its own record, so baking a
    // codex snapshot doesn't invalidate the claude one.
    state.variants = { ...state.variants, [variantKey]: entry };
    // `base` stays the AGENTLESS base, never the newest bake. Provider-generic
    // readers (freshness, bake sharing, prepared-custody) reach straight for
    // `base.contextSha256` and assume it describes the agentless context. Point
    // that at a codex snapshot and they all compare an agentless fingerprint
    // against a codex-folded one and report a permanent false "stale".
    if (!derived) state.base = entry;
    writePreparedState(state);
    log(`prepare-digitalocean: wrote ${preparedStatePath()}`);

    // Reap the snapshot this bake replaces -- ONLY after the new one is
    // recorded, so a failed bake never leaves the user with no base, and only
    // the entry for this exact variant, so a codex re-bake can't delete the
    // claude snapshot. Best-effort: an orphaned snapshot costs storage, a
    // failed prepare costs the user their base.
    if (superseded !== undefined && superseded !== snapshotId) {
      progress(`removing superseded snapshot ${String(superseded)}`);
      await client.deleteSnapshot(String(superseded)).catch((err: unknown) => {
        log(
          `prepare-digitalocean: could not delete superseded snapshot ${String(superseded)} (continuing): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    // 9. Cleanup: delete droplet first (cleanly detaches the firewall), then
    // the firewall.
    progress(`deleting temp Droplet ${String(dropletId)}`);
    await client.deleteDroplet(dropletId);
    dropletId = null;
    progress(`deleting per-prepare firewall ${firewallId}`);
    await deletePerBoxFirewall(client, firewallId, { tags: [prepareTag] });
    firewallId = null;

    progress(`prepare complete — base snapshot ${String(snapshotId)} (${description})`);
    return { snapshotName: description, imageId: snapshotId };
  } catch (err) {
    // Failure cleanup — best-effort. Always try to delete the Droplet first
    // (it costs money if left running). Surface the original error.
    if (dropletId !== null) {
      log(
        `prepare-digitalocean: cleanup — deleting temp Droplet ${String(dropletId)} after failure`,
      );
      try {
        await client.deleteDroplet(dropletId);
      } catch (cleanupErr) {
        log(
          `prepare-digitalocean: WARN — failed to delete temp Droplet ${String(dropletId)}; check the DigitalOcean dashboard manually. ${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
    }
    if (firewallId !== null) {
      log(
        `prepare-digitalocean: cleanup — deleting per-prepare firewall ${firewallId} after failure`,
      );
      try {
        await deletePerBoxFirewall(client, firewallId, { tags: [prepareTag] });
      } catch (cleanupErr) {
        log(
          `prepare-digitalocean: WARN — failed to delete firewall ${firewallId}; check the DigitalOcean dashboard manually. ${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
    }
    throw err;
  } finally {
    await key.cleanup();
  }
}

/**
 * Provider-level binding used by the CLI's `prepare` command. Matches the
 * shape of `hetznerProvider.prepare`.
 */
export const prepareDigitalOceanProvider: NonNullable<Provider['prepare']> = (req) =>
  prepareDigitalOcean({
    name: req.name,
    hostWorkspace: req.hostWorkspace ?? process.cwd(),
    force: req.force,
    // Region for the temp bake Droplet (defaults to nyc3 when unset). Resolved
    // by the CLI from `--location` / `box.digitaloceanRegion`.
    region: req.location,
    // Droplet size for the temp bake VPS (CLI `--size` / `box.sizeDigitalocean`).
    size: req.size,
    // Forward the Claude install mode (native | npm) so the `npm` escape hatch
    // (box.claudeInstall / --claude-install npm) reaches the bake — the native
    // installer's CDN 403s some datacenter egress IPs. (matches Hetzner.)
    claudeInstall: req.claudeInstall,
    // Empty/absent bakes the agentless base; a set bakes a derived snapshot.
    ...(req.agents ? { agents: req.agents } : {}),
    onLog: req.onLog,
  });

/**
 * First-use gate. If no base snapshot is recorded in
 * `~/.agentbox/digitalocean-prepared.json`, throws an actionable error
 * pointing at `agentbox prepare --provider digitalocean`.
 *
 * Called by `backend.provision()` lazily so `agentbox prepare --provider
 * digitalocean` itself can run without tripping the gate.
 */
export async function ensureDigitalOceanBaseSnapshot(): Promise<void> {
  const state = readPreparedState();
  if (state.base !== undefined) return;
  throw new UserFacingError(
    'no DigitalOcean base snapshot found.\n' +
      'Run `agentbox prepare --provider digitalocean` first (DigitalOcean cannot build images from a Dockerfile,\n' +
      'so the base snapshot is a one-time prerequisite for cloud boxes on this backend).',
  );
}

export type { ResolvedAsset };
