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
import type { Provider } from '@agentbox/core';
import { computeContextSha256, readCliStamp } from '@agentbox/sandbox-core';
import {
  stageClaudeStaticForUpload,
  stageCodexStaticForUpload,
  stageOpencodeStaticForUpload,
  type StageResult,
} from '@agentbox/sandbox-cloud';
import { ensureHetznerCredentials } from './credentials.js';
import { detectEgressIp } from './egress-ip.js';
import {
  createPerBoxFirewall,
  deletePerBoxFirewall,
  normalizeSourceCidr,
} from './firewall.js';
import { makeHetznerClient } from './client.js';
import { generatePrepareCloudInit } from './cloud-init.js';
import {
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
import {
  scpUpload,
  sshExec,
  waitForSsh,
  type SshTargetArgs,
} from './ssh-cli.js';

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
  const contextSha = await computeContextSha256(
    assets.map((a) => ({ rel: a.name, abs: a.localPath })),
  );

  if (!opts.force && existingState.base) {
    const remote = await client
      .getImage(existingState.base.imageId)
      .catch(() => null);
    if (remote && existingState.base.contextSha256 === contextSha) {
      progress(
        `base snapshot ${String(existingState.base.imageId)} already exists (fingerprint ${contextSha.slice(0, 12)} matches); skipping rebuild (pass --force to override)`,
      );
      return {
        snapshotName: existingState.base.description,
        imageId: existingState.base.imageId,
      };
    }
    if (!remote) {
      progress(`recorded base snapshot ${String(existingState.base.imageId)} is gone on Hetzner; rebuilding`);
    } else {
      progress(
        `build context changed (was ${existingState.base.contextSha256?.slice(0, 12) ?? '<none>'}, now ${contextSha.slice(0, 12)}); rebuilding base snapshot`,
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
      sourceCidr: source,
      labels: { 'agentbox.role': 'prepare' },
    });
    firewallId = firewall.id;

    // 3. Create temp VPS.
    const serverName = `agentbox-prepare-${stamp}`;
    const cloudInit = generatePrepareCloudInit({ sshPubkey: key.publicKey });
    progress(`creating temp VPS ${serverName} (${opts.serverType ?? TEMP_SERVER_TYPE_DEFAULT} / ${opts.location ?? TEMP_SERVER_LOCATION_DEFAULT})`);
    const created = await client.createServer({
      name: serverName,
      server_type: opts.serverType ?? TEMP_SERVER_TYPE_DEFAULT,
      image: 'ubuntu-24.04',
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
      user: 'root',
      identity: key.privatePath,
      knownHosts: join(key.dir, 'known_hosts'),
    };
    const up = await waitForSsh(sshTarget, PREPARE_SSH_DEADLINE_MS);
    if (!up) {
      throw new Error(`hetzner: ssh on ${ip} did not come up within ${String(PREPARE_SSH_DEADLINE_MS / 1000)}s`);
    }
    progress('ssh up — scp\'ing runtime assets');

    // 5. scp every asset into /tmp/ **sequentially**. Parallel uploads
    // through 10 fresh ssh connections trip sshd's MaxStartups (10:30:100
    // default) on a freshly-booted VPS — surviving connections look fine
    // but some randomly write 0 bytes to the destination. The sequential
    // form is plenty fast (each file is small, total ~1MB).
    for (const asset of assets) {
      const remote = `/tmp/${asset.remoteBasename}`;
      log(`prepare-hetzner: scp ${asset.name} -> ${remote}`);
      await scpUpload(sshTarget, asset.localPath, remote);
      if (asset.remoteMode !== undefined) {
        const modeOctal = asset.remoteMode.toString(8);
        await sshExec(sshTarget, `chmod ${modeOctal} ${remote}`);
      }
    }

    // 6. Run the install script. We trace via `bash -x` and tee the full
    // output to /var/log/agentbox/install.log on the VPS so the trace
    // survives into the snapshot — handy when diagnosing a step that ran
    // (or didn't) deep inside the install. Stream stdout/stderr through
    // `onLog` so `prepare.log` shows the BEGIN/END markers in real time.
    // `set -o pipefail` so the pipe's exit code is bash's, not tee's.
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
      throw new Error(
        `install-box.sh failed on temp VPS (exit ${String(installRes.exitCode)})\n` +
          `Last stderr: ${installRes.stderr.slice(-500) || '(empty)'}\n` +
          `The full trace was preserved at /var/log/agentbox/install.log inside any box made from the resulting snapshot.`,
      );
    }
    progress('install script complete');

    // 6b. Stage host agent static config (~/.claude plugins/skills/settings/
    // _claude.json, ~/.codex config + prompts, ~/.local/share/opencode), scp
    // each tarball, extract into /home/vscode/ as the `vscode` user. Mirrors
    // the Daytona bake step (`Image.addLocalFile` + `Image.runCommands`),
    // adapted for our ssh+scp model. Without this, the in-box claude/codex/
    // opencode boot with no plugins, no skills, no settings, and prompt the
    // user to log in fresh on every box.
    progress('staging host agent static config');
    const stagings: Array<{ kind: 'claude' | 'codex' | 'opencode'; tar: StageResult; dest: string }> = [];
    try {
      const claudeTar = await stageClaudeStaticForUpload({ hostWorkspace: opts.hostWorkspace });
      for (const w of claudeTar.warnings) log(`prepare-hetzner: ${w}`);
      if (claudeTar.tarballPath) stagings.push({ kind: 'claude', tar: claudeTar, dest: '/home/vscode/.claude' });
      else await claudeTar.cleanup();

      const codexTar = await stageCodexStaticForUpload();
      for (const w of codexTar.warnings) log(`prepare-hetzner: ${w}`);
      if (codexTar.tarballPath) stagings.push({ kind: 'codex', tar: codexTar, dest: '/home/vscode/.codex' });
      else await codexTar.cleanup();

      const opencodeTar = await stageOpencodeStaticForUpload();
      for (const w of opencodeTar.warnings) log(`prepare-hetzner: ${w}`);
      if (opencodeTar.tarballPath) stagings.push({ kind: 'opencode', tar: opencodeTar, dest: '/home/vscode/.local/share/opencode' });
      else await opencodeTar.cleanup();

      for (const s of stagings) {
        const remote = `/tmp/agentbox-${s.kind}-static.tar.gz`;
        log(`prepare-hetzner: scp ${s.kind} static (${s.tar.tarballPath}) -> ${remote}`);
        await scpUpload(sshTarget, s.tar.tarballPath as string, remote);
        // Extract as vscode so the files land owned by uid 1000. The dir
        // already exists (created by the install script's credential-pivot
        // step) — extract into it, don't replace it.
        const extractCmd =
          `sudo -u vscode mkdir -p ${s.dest} && ` +
          `sudo -u vscode tar -xzf ${remote} -C ${s.dest} --no-same-permissions --no-same-owner -m && ` +
          `rm -f ${remote}`;
        const r = await sshExec(sshTarget, extractCmd, { onLine: (line) => log(`[stage:${s.kind}] ${line}`) });
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
    const description = opts.name ?? `agentbox-base-${stamp}`;
    progress(`creating snapshot '${description}' from VPS ${String(serverId)}`);
    const snap = await client.createImage(serverId, {
      type: 'snapshot',
      description,
      labels: { 'agentbox.role': 'base', 'agentbox.schema': '1' },
    });
    progress(`snapshot create requested (image id ${String(snap.image.id)}); polling until available`);
    const ready = await pollUntil(
      `image ${String(snap.image.id)} availability`,
      async () => {
        const img = await client.getImage(snap.image.id);
        if (!img) return null;
        if (img.status === 'available') return img;
        return null;
      },
      { deadlineMs: SNAPSHOT_DEADLINE_MS, intervalMs: 3_000, maxIntervalMs: 10_000, onPoll: (l) => log(`prepare-hetzner: ${l}`) },
    );

    // 8. Persist before tearing down — if the cleanup fails we still know
    // about the new snapshot.
    progress('persisting hetzner-prepared.json');
    const state = readPreparedState();
    const cliStamp = readCliStamp();
    state.base = {
      imageId: ready.id,
      description: ready.description,
      createdAt: new Date().toISOString(),
      contextSha256: contextSha,
      cliVersion: cliStamp.cliVersion,
      cliCommit: cliStamp.cliCommit,
    };
    writePreparedState(state);
    log(`prepare-hetzner: wrote ${preparedStatePath()}`);

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
      log(`prepare-hetzner: cleanup — deleting per-prepare firewall ${String(firewallId)} after failure`);
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
    onLog: req.onLog,
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
  throw new Error(
    'no Hetzner base snapshot found.\n' +
      'Run `agentbox prepare --provider hetzner` first (Hetzner cannot build images from a Dockerfile,\n' +
      'so the base snapshot is a one-time prerequisite for cloud boxes on this backend).',
  );
}

export type { ResolvedAsset };
