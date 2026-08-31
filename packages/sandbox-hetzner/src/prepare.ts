/**
 * `agentbox prepare --provider hetzner` — bake the per-org Hetzner base
 * snapshot. Mirrors the user request: "for `agentbox prepare` (and first
 * time hetzner is used) start a VM and set it up and snapshot as base image
 * (there's no way to start a VPS from an existing dockerfile)."
 *
 * Flow:
 *   1. Mint an ephemeral SSH keypair under
 *      ~/.agentbox/hetzner/prepare-<ts>/.
 *   2. Detect the host's egress IP and create a firewall locked to it,
 *      named `agentbox-prepare-<ts>`.
 *   3. Create a temp VPS (Ubuntu 24.04, `cx22` default) with cloud-init
 *      injecting the pubkey for `root`.
 *   4. Poll until cloud-init + sshd come up.
 *   5. scp the runtime assets (install script + agentbox-ctl + helpers +
 *      baked config files) into /tmp.
 *   6. Run `bash /tmp/agentbox-install.sh` over ssh; stream stdout to the
 *      prepare log via the `onLog` callback.
 *   7. `create_image` snapshot of the VPS; poll until `available`.
 *   8. Delete the VPS + firewall.
 *   9. Persist the snapshot id into `~/.agentbox/hetzner-prepared.json`.
 *
 * Failure-mode discipline: each major step is wrapped in try/catch so the
 * temp VPS + firewall are *always* cleaned up on failure (the user must
 * never end up with a forgotten €4/mo VPS due to a prepare error).
 *
 * The user requested noisy logging — every BEGIN/END marker from the
 * install script is forwarded verbatim into the prepare log, plus our own
 * step boundaries from `progress()`.
 */

import { join } from 'node:path';
import type { AgentId, Provider } from '@agentbox/core';
import { UserFacingError } from '@agentbox/core';
import {
  computeContextManifest,
  readCliStamp,
  variantFingerprint,
  normalizeAgentSet,
  agentSetArg,
  resolveAgentSpec,
  resolveAgentInstall,
  renderInstallRecipe,
  renderPackageInstall,
} from '@agentbox/sandbox-core';
import { type StageResult, stageAllAgentStatic } from '@agentbox/sandbox-cloud';
import { ensureHetznerCredentials } from './credentials.js';
import { detectEgressIp } from './egress-ip.js';
import { createPerBoxFirewall, deletePerBoxFirewall, normalizeSourceCidr } from './firewall.js';
import { makeHetznerClient } from './client.js';
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
import { validateServerChoice } from './preflight.js';
import { mintPrepareKey } from './ssh-key.js';

/** Wrap a shell snippet in single quotes for safe nesting inside `bash -lc`. */
function shellSingleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
import { scpUpload, sshExec, waitForSsh, type SshTargetArgs } from './ssh-cli.js';

export interface PrepareHetznerOptions {
  name?: string;
  hostWorkspace?: string;
  /** Force re-bake even when `~/.agentbox/hetzner-prepared.json` has a usable base. */
  force?: boolean;
  /** Hetzner location (defaults to `nbg1`). */
  location?: string;
  /** Server type (defaults to `cx22` — 2 vCPU / 4 GB / 40 GB / ~€4/mo). */
  serverType?: string;
  /**
   * Override the firewall source CIDR. Defaults to auto-detected egress IP
   * via `detectEgressIp()` (with `/32` appended). Pass `'0.0.0.0/0'` for
   * the explicit-open opt-in. Passing a bare IP appends `/32` automatically.
   */
  firewallSource?: string;
  /** CLI runtime tree (set by the CLI to its dist neighbor). */
  cliRuntimeRoot?: string;
  /** Repo root for the dev fallback (defaults to `process.cwd()` walk). */
  repoRoot?: string;
  /** How the claude recipe installs Claude Code (`native` default | `npm`). */
  agentInstall?: 'native' | 'npm';
  /**
   * Agents to bake in. Empty/omitted bakes the AGENTLESS base.
   *
   * A non-empty set bakes a DERIVED snapshot: boot the existing base, run only
   * those agents' install recipes, re-snapshot. That is why it can't just be
   * another env var for install-box.sh — the base snapshot already has the
   * expensive layers, and re-running the whole script would rebuild them.
   */
  agents?: string[];
  onLog?: (line: string) => void;
}

export interface PrepareHetznerResult {
  snapshotName?: string;
  /** Hetzner image id (numeric) — also recorded in hetzner-prepared.json. */
  imageId?: number;
}

// `cx22` was deprecated by Hetzner in early 2026; `cx23` is the drop-in
// replacement with the same 2 vCPU / 4 GB / 40 GB shape on x86. Users can
// still override via `prepareHetzner({serverType: ...})`.
const TEMP_SERVER_TYPE_DEFAULT = 'cx23';
const TEMP_SERVER_LOCATION_DEFAULT = 'nbg1';
const PREPARE_SSH_DEADLINE_MS = 5 * 60_000;
const INSTALL_SCRIPT_TIMEOUT_MS = 30 * 60_000;
const SNAPSHOT_DEADLINE_MS = 20 * 60_000;

/**
 * Bake the per-org Hetzner base snapshot. Resolves only after the image is
 * `available` and the temp VPS + firewall are gone. Persists `{base.imageId,
 * base.description, base.createdAt, base.installScriptSha256}` into
 * `~/.agentbox/hetzner-prepared.json`.
 */
export async function prepareHetzner(
  opts: PrepareHetznerOptions = {},
): Promise<PrepareHetznerResult> {
  await ensureHetznerCredentials();
  const client = makeHetznerClient();
  const log = opts.onLog ?? (() => {});
  const progress = (step: string) => log(`prepare-hetzner: ${step}`);

  // Skip-fast: if a base snapshot is already recorded *and* its image is
  // still on Hetzner *and* the build-context fingerprint hasn't changed *and*
  // --force was not passed, return the existing record.
  const existingState = readPreparedState();
  // Prefer an explicit override; otherwise auto-detect the published-CLI
  // staged runtime tree by inspecting where this module was loaded from.
  const assets = resolveRuntimeAssets({
    cliRuntimeRoot: opts.cliRuntimeRoot ?? findStagedCliRuntimeRoot(),
    repoRoot: opts.repoRoot,
  });
  // Fingerprint = hash of every asset we scp into the prepare VPS. Keyed on
  // logical name (stable across staged-vs-monorepo layouts) so two CLIs with
  // the same staged tree produce the same hash.
  const agentInstall = opts.agentInstall ?? 'native';
  // Keep the per-file digests, not just the fold: a later `stale` verdict can
  // then name the files that changed instead of only reporting a moved hash.
  const contextManifest = await computeContextManifest(
    assets.map((a) => ({ rel: a.name, abs: a.localPath })),
  );
  const agents = normalizeAgentSet(opts.agents);
  const variantKey = agentSetArg(agents);
  const derived = agents.length > 0;
  const contextSha = variantFingerprint(contextManifest.contextSha256, { agentInstall, agents });

  // A derived bake boots the agentless base, so that has to exist first.
  const baseEntry = preparedEntryFor(existingState, '');
  if (derived && !baseEntry) {
    throw new Error(
      'no Hetzner base snapshot to derive from — run `agentbox prepare --provider hetzner` first, ' +
        'then re-run with --agents.',
    );
  }

  const existingEntry = preparedEntryFor(existingState, variantKey);
  if (!opts.force && existingEntry) {
    const remote = await client.getImage(existingEntry.imageId).catch(() => null);
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
        `recorded ${variantKey || 'base'} snapshot ${String(existingEntry.imageId)} is gone on Hetzner; rebuilding`,
      );
    } else {
      progress(
        `build context changed (was ${existingEntry.contextSha256?.slice(0, 12) ?? '<none>'}, now ${contextSha.slice(0, 12)}); rebuilding ${variantKey || 'base'} snapshot`,
      );
    }
  }

  // 1. Mint ephemeral key + detect egress IP in parallel.
  progress('minting ephemeral ssh key');
  const key = await mintPrepareKey();
  let firewallId: number | null = null;
  let serverId: number | null = null;
  try {
    progress('detecting host egress IP');
    const source = opts.firewallSource
      ? normalizeSourceCidr(opts.firewallSource)
      : `${await detectEgressIp({ onLog: log })}/32`;

    // 2. Create per-prepare firewall.
    const stamp = Date.now().toString(36);
    const firewallName = `agentbox-prepare-${stamp}`;
    progress(`creating firewall ${firewallName} (source ${source})`);
    const firewall = await createPerBoxFirewall(client, {
      name: firewallName,
      sources: [source],
      labels: { 'agentbox.role': 'prepare' },
    });
    firewallId = firewall.id;

    // 3. Create temp VPS.
    //
    // A derived bake boots a snapshot, so the temp server type must have a disk
    // at least as large as that snapshot — a check the plain base bake never
    // needed (Hetzner sizes its own stock images). Same validator the box path
    // uses, so the failure reads identically.
    if (derived) {
      const [catalog, baseImage] = await Promise.all([
        client.listServerTypes(),
        client.getImage(baseEntry!.imageId).catch(() => null),
      ]);
      validateServerChoice(
        {
          serverType: opts.serverType ?? TEMP_SERVER_TYPE_DEFAULT,
          location: opts.location ?? TEMP_SERVER_LOCATION_DEFAULT,
        },
        catalog,
        baseImage,
      );
    }

    const serverName = `agentbox-prepare-${stamp}`;
    const cloudInit = derived
      ? generateDerivedPrepareCloudInit({ sshPubkey: key.publicKey })
      : generatePrepareCloudInit({ sshPubkey: key.publicKey });
    progress(
      `creating temp VPS ${serverName} (${opts.serverType ?? TEMP_SERVER_TYPE_DEFAULT} / ${opts.location ?? TEMP_SERVER_LOCATION_DEFAULT})`,
    );
    const created = await client.createServer({
      name: serverName,
      server_type: opts.serverType ?? TEMP_SERVER_TYPE_DEFAULT,
      // A derived bake boots the agentless base snapshot; the plain base bake
      // starts from Hetzner's stock image. `image` accepts a numeric snapshot
      // id — the box path does exactly this (backend.ts resolveImageId).
      image: derived ? baseEntry!.imageId : 'ubuntu-24.04',
      location: opts.location ?? TEMP_SERVER_LOCATION_DEFAULT,
      user_data: cloudInit,
      firewalls: [{ firewall: firewall.id }],
      labels: { 'agentbox.managed': 'true', 'agentbox.role': 'prepare' },
      start_after_create: true,
    });
    serverId = created.server.id;
    const ip = created.server.public_net.ipv4?.ip;
    if (!ip) {
      throw new Error('hetzner: temp VPS came up without an IPv4 address');
    }

    // 4. Wait for sshd.
    progress(`waiting for ssh on ${ip} (deadline ${String(PREPARE_SSH_DEADLINE_MS / 1000)}s)`);
    const sshTarget: SshTargetArgs = {
      host: ip,
      // A derived bake boots the base snapshot, whose sshd drop-in already has
      // `PermitRootLogin no` — see generateDerivedPrepareCloudInit.
      user: derived ? 'vscode' : 'root',
      identity: key.privatePath,
      knownHosts: join(key.dir, 'known_hosts'),
    };
    const up = await waitForSsh(sshTarget, PREPARE_SSH_DEADLINE_MS);
    if (!up) {
      throw new Error(
        `hetzner: ssh on ${ip} did not come up within ${String(PREPARE_SSH_DEADLINE_MS / 1000)}s`,
      );
    }
    progress("ssh up — scp'ing runtime assets");

    // 5. scp every asset into /tmp/ **sequentially**. Parallel uploads
    // through 10 fresh ssh connections trip sshd's MaxStartups (10:30:100
    // default) on a freshly-booted VPS — surviving connections look fine
    // but some randomly write 0 bytes to the destination. The sequential
    // form is plenty fast (each file is small, total ~1MB).
    if (!derived) {
      for (const asset of assets) {
        const remote = `/tmp/${asset.remoteBasename}`;
        log(`prepare-hetzner: scp ${asset.name} -> ${remote}`);
        await scpUpload(sshTarget, asset.localPath, remote);
        if (asset.remoteMode !== undefined) {
          const modeOctal = asset.remoteMode.toString(8);
          await sshExec(sshTarget, `chmod ${modeOctal} ${remote}`);
        }
      }
    }

    // 6. Run the install script. We trace via `bash -x` and tee the full
    // output to /var/log/agentbox/install.log on the VPS so the trace
    // survives into the snapshot — handy when diagnosing a step that ran
    // (or didn't) deep inside the install. Stream stdout/stderr through
    // `onLog` so `prepare.log` shows the BEGIN/END markers in real time.
    // `set -o pipefail` so the pipe's exit code is bash's, not tee's.
    if (derived) {
      // Derived bake: run ONLY the agent recipes. The base snapshot already
      // carries the expensive layers, and install-box.sh can't be re-run anyway
      // — its own trim step deletes it from /tmp before the snapshot.
      //
      // The recipes come from the same AGENT_SYNC_SPECS data the docker derived
      // layer and `ensureAgentInstalled` use, so a hetzner-baked agent and a
      // runtime-added one are installed identically.
      for (const id of agents) {
        const spec = resolveAgentSpec(id);
        const install = resolveAgentInstall(spec.install, agentInstall);
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
            `{ echo "prepare-hetzner: ${spec.id} not on PATH after install" >&2; exit 71; }`,
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
            `hetzner: installing ${spec.id} into the derived snapshot failed (exit ${String(res.exitCode)}).`,
          );
        }
      }
    } else {
      // No AGENTBOX_AGENT_INSTALL here any more: the base installs no agents,
      // so the mode has nothing to select. It still folds into the fingerprint
      // (below) because the derived bake reads it, and the two tiers share one
      // fingerprint chain.
      progress('running install-box.sh on temp VPS (this takes ~5-15 min)');
      const installRes = await sshExec(
        sshTarget,
        `sudo mkdir -p /var/log/agentbox && set -o pipefail && bash -x /tmp/agentbox-install.sh 2>&1 | sudo tee /var/log/agentbox/install.log`,
        {
          timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS,
          onLine: (line) => log(`[install] ${line}`),
        },
      );
      if (installRes.exitCode !== 0) {
        // Exit 71 is install-box.sh's dedicated sentinel for "Claude Code native
        // installer failed after its retries" — almost always a transient
        // Cloudflare 403 that claude.ai / downloads.claude.ai return to
        // cloud-datacenter egress IPs under load. Surface an actionable message
        // instead of the opaque generic one (stderr is empty here because the
        // install runs `bash -x ... 2>&1 | tee`, merging stderr into stdout).
        if (installRes.exitCode === 71) {
          throw new Error(
            `Claude Code's native installer could not be reached from the Hetzner VPS after 3 retries (~5 min).\n` +
              `This is a transient Cloudflare 403. It usually clears within a few minutes.\n\n` +
              `What to do: wait a moment, then re-run \`agentbox prepare --provider hetzner --force\`.\n` +
              `Full trace: /var/log/agentbox/install.log inside any box made from the resulting snapshot.`,
          );
        }
        throw new Error(
          `install-box.sh failed on temp VPS (exit ${String(installRes.exitCode)})\n` +
            `Last stderr: ${installRes.stderr.slice(-500) || '(empty)'}\n` +
            `The full trace was preserved at /var/log/agentbox/install.log inside any box made from the resulting snapshot.`,
        );
      }
      progress('install script complete');
    }

    // 6b. Stage host agent static config (~/.claude plugins/skills/settings/
    // _claude.json, ~/.codex config + prompts, ~/.local/share/opencode), scp
    // each tarball, extract into /home/vscode/ as the `vscode` user. Mirrors
    // the Daytona bake step (`Image.addLocalFile` + `Image.runCommands`),
    // adapted for our ssh+scp model. Without this, the in-box claude/codex/
    // opencode boot with no plugins, no skills, no settings, and prompt the
    // user to log in fresh on every box.
    progress('staging host agent static config');
    // Only the agents this snapshot is for: staging every agent's host config
    // into a claude-only snapshot would put codex/opencode settings (and their
    // credential paths) into a box that will never run them.
    // `~/.agents` is always staged — shared skills, not an agent's auth.
    const stagings: Array<{
      kind: AgentId | 'agents';
      tar: StageResult;
      dest: string;
    }> = [];
    const wantsAll = agents.length === 0;
    try {
      const stages = await stageAllAgentStatic({
        hostWorkspace: opts.hostWorkspace,
        agents: wantsAll ? undefined : agents,
      });
      for (const s of stages) {
        for (const w of s.staged.warnings) log(`prepare-hetzner: ${w}`);
        if (s.staged.tarballPath)
          stagings.push({ kind: s.kind, tar: s.staged, dest: s.extractDir });
        else await s.staged.cleanup();
      }

      for (const s of stagings) {
        const remote = `/tmp/agentbox-${s.kind}-static.tar.gz`;
        log(`prepare-hetzner: scp ${s.kind} static (${s.tar.tarballPath}) -> ${remote}`);
        await scpUpload(sshTarget, s.tar.tarballPath as string, remote);
        // Extract as vscode so the files land owned by uid 1000. The dir may
        // not exist yet (agent home dirs are created by each agent's
        // install.postInstall now, so an agentless base has none) — mkdir -p
        // first, then extract into it rather than replacing it.
        const extractCmd =
          `sudo -u vscode mkdir -p ${s.dest} && ` +
          `sudo -u vscode tar -xzf ${remote} -C ${s.dest} --no-same-permissions --no-same-owner -m && ` +
          `rm -f ${remote}`;
        const r = await sshExec(sshTarget, extractCmd, {
          onLine: (line) => log(`[stage:${s.kind}] ${line}`),
        });
        if (r.exitCode !== 0) {
          throw new Error(
            `prepare-hetzner: ${s.kind} static extract failed (exit ${String(r.exitCode)}): ${r.stderr.slice(-300)}`,
          );
        }
        progress(`baked ${s.kind} static config into snapshot`);
      }
    } finally {
      for (const s of stagings) await s.tar.cleanup();
    }

    // 7. Snapshot.
    // Variants name themselves after their agent set: they show up beside the
    // base in the Hetzner console and in `agentbox prune`, and "which snapshot
    // is which" should not require looking up an id in a local JSON file.
    // Flush the page cache before snapshotting. Both providers image a LIVE
    // machine, so anything still buffered is simply absent from the resulting
    // snapshot -- silently, because the writes themselves succeeded. The static
    // config stage right above writes tens of MB and then we snapshot within
    // milliseconds, which lost every staged skill on a live derived bake while
    // `tar` reported exit 0 and the bake reported success.
    progress('flushing the page cache before snapshot');
    const hzSync = await sshExec(sshTarget, 'sudo sync && sudo sync', { timeoutMs: 120_000 });
    if (hzSync.exitCode !== 0) {
      throw new Error(
        `hetzner: sync before snapshot failed (exit ${String(hzSync.exitCode)}); ` +
          'refusing to snapshot a VPS whose writes may not be on disk.',
      );
    }

    const description =
      opts.name ?? `agentbox-${derived ? variantKey.replaceAll(',', '-') : 'base'}-${stamp}`;
    progress(`creating snapshot '${description}' from VPS ${String(serverId)}`);
    const snap = await client.createImage(serverId, {
      type: 'snapshot',
      description,
      // `agentbox.agents` is what makes an orphan sweep able to tell a variant
      // from the base without consulting the local prepared state. Empty label
      // values are rejected by Hetzner, so the agentless base uses `none`.
      labels: {
        'agentbox.role': 'base',
        'agentbox.schema': '1',
        'agentbox.agents': derived ? variantKey.replaceAll(',', '-') : 'none',
      },
    });
    progress(
      `snapshot create requested (image id ${String(snap.image.id)}); polling until available`,
    );
    const ready = await pollUntil(
      `image ${String(snap.image.id)} availability`,
      async () => {
        const img = await client.getImage(snap.image.id);
        if (!img) return null;
        if (img.status === 'available') return img;
        return null;
      },
      {
        deadlineMs: SNAPSHOT_DEADLINE_MS,
        intervalMs: 3_000,
        maxIntervalMs: 10_000,
        onPoll: (l) => log(`prepare-hetzner: ${l}`),
      },
    );

    // 8. Persist before tearing down — if the cleanup fails we still know
    // about the new snapshot.
    progress('persisting hetzner-prepared.json');
    const state = readPreparedState();
    const cliStamp = readCliStamp();
    const superseded = preparedEntryFor(state, variantKey)?.imageId;
    const entry = {
      imageId: ready.id,
      description: ready.description,
      createdAt: new Date().toISOString(),
      contextSha256: contextSha,
      files: contextManifest.files,
      cliVersion: cliStamp.cliVersion,
      cliCommit: cliStamp.cliCommit,
    };
    // Merge, never replace: each variant keeps its own record, so baking a
    // codex snapshot doesn't invalidate the claude one.
    state.variants = { ...state.variants, [variantKey]: entry };
    // `base` stays the AGENTLESS base, never the newest bake. Several readers
    // outside this package are provider-generic and reach straight for
    // `base.contextSha256` — the freshness/staleness surface, bake sharing, the
    // control-box custody adoption. Point that at a codex snapshot and they all
    // compare an agentless fingerprint against a codex-folded one and report a
    // permanent false "stale".
    if (!derived) state.base = entry;
    writePreparedState(state);
    log(`prepare-hetzner: wrote ${preparedStatePath()}`);

    // Reap the snapshot this bake replaces — ONLY after the new one is
    // recorded, so a failed bake never leaves the user with no base, and only
    // the entry for this exact variant (a claude re-bake must not touch the
    // codex snapshot). Hetzner had no base-snapshot GC at all before this:
    // every re-bake orphaned its predecessor, and nothing prunes them.
    if (superseded !== undefined && superseded !== ready.id) {
      progress(`removing superseded snapshot ${String(superseded)}`);
      await client.deleteImage(superseded).catch((err: unknown) => {
        log(
          `prepare-hetzner: could not delete superseded snapshot ${String(superseded)} ` +
            `(continuing): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    // 9. Cleanup: delete server first (cleanly detaches from firewall),
    // then the firewall.
    progress(`deleting temp VPS ${String(serverId)}`);
    await client.deleteServer(serverId);
    serverId = null;
    progress(`deleting per-prepare firewall ${String(firewallId)}`);
    await deletePerBoxFirewall(client, firewallId);
    firewallId = null;

    progress(`prepare complete — base snapshot ${String(ready.id)} (${ready.description})`);
    return { snapshotName: ready.description, imageId: ready.id };
  } catch (err) {
    // Failure cleanup — best-effort. Always try to delete the VPS first
    // (it costs €4/mo if left running). Surface the original error in any
    // case.
    if (serverId !== null) {
      log(`prepare-hetzner: cleanup — deleting temp VPS ${String(serverId)} after failure`);
      try {
        await client.deleteServer(serverId);
      } catch (cleanupErr) {
        log(
          `prepare-hetzner: WARN — failed to delete temp VPS ${String(serverId)}; check the Hetzner dashboard manually. ${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
    }
    if (firewallId !== null) {
      log(
        `prepare-hetzner: cleanup — deleting per-prepare firewall ${String(firewallId)} after failure`,
      );
      try {
        await deletePerBoxFirewall(client, firewallId);
      } catch (cleanupErr) {
        log(
          `prepare-hetzner: WARN — failed to delete firewall ${String(firewallId)}; check the Hetzner dashboard manually. ${
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
 * shape of `daytonaProvider.prepare`.
 */
export const prepareHetznerProvider: NonNullable<Provider['prepare']> = (req) =>
  prepareHetzner({
    name: req.name,
    hostWorkspace: req.hostWorkspace ?? process.cwd(),
    force: req.force,
    // Datacenter for the temp bake VPS (defaults to nbg1 when unset). Resolved
    // by the CLI from `--location` / `box.hetznerLocation`.
    location: req.location,
    onLog: req.onLog,
    // Forward the Claude install mode (native | npm). Without this the Hetzner
    // bake always ran the native `curl install.sh`, whose CDN 403s datacenter
    // egress IPs — the `npm` escape hatch (box.agentInstall / --agent-install
    // npm) never reached the bake. (matches prepareVercelProvider.)
    agentInstall: req.agentInstall,
    // Empty/absent bakes the agentless base; a set bakes a derived snapshot.
    ...(req.agents ? { agents: req.agents } : {}),
  });

/**
 * First-use gate. If no base snapshot is recorded in
 * `~/.agentbox/hetzner-prepared.json`, throws an actionable error pointing
 * at `agentbox prepare --provider hetzner`.
 *
 * This is called by `backend.provision()` (lazily, from Phase 4 onward) so
 * `agentbox prepare --provider hetzner` itself can run without tripping
 * the gate.
 *
 * Phase 4 will widen this to also re-check the image is still on Hetzner
 * (404 → retrigger prepare prompt). For now it just gates on the local
 * record so the build is honest about the failure mode.
 */
export async function ensureHetznerBaseSnapshot(): Promise<void> {
  const state = readPreparedState();
  if (state.base !== undefined) return;
  throw new UserFacingError(
    'no Hetzner base snapshot found.\n' +
      'Run `agentbox prepare --provider hetzner` first (Hetzner cannot build images from a Dockerfile,\n' +
      'so the base snapshot is a one-time prerequisite for cloud boxes on this backend).',
  );
}

export type { ResolvedAsset };
