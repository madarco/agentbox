import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadEffectiveConfig } from '@agentbox/config';
import {
  syncAgentboxSshConfig,
  controlPlaneDeployPath,
  type ControlPlaneDeployRecord,
  type HubDeploySource,
} from '@agentbox/sandbox-core';
import {
  deployControlPlaneToHetzner,
  destroyControlPlaneOnHetzner,
  readHetznerCredStatus,
  updateControlPlaneOnHetzner,
  type ControlPlaneDestroyResult,
} from '@agentbox/sandbox-hetzner';

/**
 * CLI wrapper for the Hetzner control-plane deploy: precheck the token, run the
 * provisioning in `@agentbox/sandbox-hetzner`, and persist the deploy record so
 * a later command (or the user) can find / tear down the VPS.
 */
export interface HetznerDeployOptions {
  /** Path to the setup-written control-plane.env (scp'd to the VPS as `.env`). */
  envPath: string;
  /** Where the VPS gets the hub from — the npm package, or a cloned ref. */
  source: HubDeploySource;
  /**
   * Serve on a hostname you control instead of the default `<ip>.sslip.io`. Point
   * its DNS at the VPS first — Caddy proves ownership over HTTP-01, so a name
   * that doesn't resolve to this machine never gets a certificate. Also the way
   * out of a Let's Encrypt rate limit: sslip.io derives its name from the IP, so
   * a recycled address can arrive already at the per-hostname cap.
   */
  domain?: string;
  log: (line: string) => void;
  /**
   * Fired once the VPS exists, before the build + healthz poll. Lets the caller
   * report how to reach the machine when a later step fails — the server is not
   * torn down, so it is inspectable (and billable) either way.
   */
  onProvisioned?: (info: ControlPlaneDeployRecord) => void;
}

/**
 * Write `~/.agentbox/control-plane/deploy.json` and refresh the managed SSH
 * config so `ssh agentbox-hub` reaches the control box.
 *
 * Called BEFORE the build/healthz steps as well as after success: a deploy that
 * dies at `docker compose up` or on a 502 is exactly the case where the user
 * needs to get into the VPS, and it used to leave no trace of how.
 */
export async function persistDeployRecord(record: ControlPlaneDeployRecord): Promise<void> {
  const deployPath = controlPlaneDeployPath();
  await mkdir(dirname(deployPath), { recursive: true });
  await writeFile(deployPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  try {
    // Same opt-out as the per-box entries: a user who hand-maintains
    // `~/.ssh/config` gets the record on disk but no managed Host block.
    const cfg = await loadEffectiveConfig(homedir());
    if (cfg.effective.ssh.autoConfig) await syncAgentboxSshConfig();
  } catch {
    // Best-effort — the ssh alias is a convenience; the record above is what matters.
  }
}

export async function runHetznerDeploy(opts: HetznerDeployOptions): Promise<{ url: string }> {
  if (readHetznerCredStatus().source === 'none') {
    throw new Error('no HCLOUD_TOKEN configured — run `agentbox hetzner login` first');
  }
  const envContent = await readFile(opts.envPath, 'utf8');
  const result = await deployControlPlaneToHetzner({
    envContent,
    source: opts.source,
    ...(opts.domain ? { domain: opts.domain } : {}),
    onLog: opts.log,
    onProvisioned: async (info) => {
      const record: ControlPlaneDeployRecord = {
        provider: 'hetzner',
        source: opts.source,
        ...info,
      };
      opts.onProvisioned?.(record);
      await persistDeployRecord(record);
    },
  });
  await persistDeployRecord({ provider: 'hetzner', source: opts.source, ...result });
  return { url: result.url };
}

/** Human-readable recovery steps for a deploy that provisioned but never went healthy. */
export function recoveryHint(record: ControlPlaneDeployRecord): string[] {
  const key = record.sshKeyDir ? join(record.sshKeyDir, 'id_ed25519') : undefined;
  // Must match the `-f` list the deploy used: compose keys the project off it, so
  // a pasted command with the wrong list reports "no such service".
  const files = [
    '-f docker-compose.yml',
    ...(record.source?.kind === 'package' ? ['-f docker-compose.package.yml'] : []),
    '-f docker-compose.caddy.yml',
  ].join(' ');
  return [
    `The VPS is still running (server ${String(record.serverId ?? '?')}, ${record.ip ?? '?'}) — inspect it:`,
    `  ssh agentbox-hub`,
    ...(key ? [`  (or: ssh -i ${key} root@${record.ip ?? '?'})`] : []),
    `  cd /opt/agentbox/apps/hub && docker compose ${files} logs --tail=200 app`,
    `SSH is firewalled to this machine's egress IP, so run it from here.`,
    `Retry the deploy with \`agentbox hub deploy hetzner\` (reuses the same GitHub App).`,
  ];
}

/** The persisted control-box record, or null when nothing was deployed here. */
export async function readDeployRecord(): Promise<ControlPlaneDeployRecord | null> {
  try {
    return JSON.parse(await readFile(controlPlaneDeployPath(), 'utf8')) as ControlPlaneDeployRecord;
  } catch {
    return null;
  }
}

/**
 * A record complete enough to reach the VPS again. `deploy.json` is written
 * mid-deploy too, so every field is optional on the type — an update or destroy
 * has to check rather than assume.
 */
export function assertReachableRecord(
  record: ControlPlaneDeployRecord | null,
): asserts record is ControlPlaneDeployRecord & { ip: string; sshKeyDir: string; url: string } {
  if (!record) {
    throw new Error(
      'no control box was deployed from this machine (~/.agentbox/control-plane/deploy.json is missing). ' +
        'Deploy one with `agentbox hub deploy hetzner`, or point at an existing hub with `agentbox hub set-url <url>`.',
    );
  }
  const missing = (['ip', 'sshKeyDir', 'url'] as const).filter((k) => !record[k]);
  if (missing.length > 0) {
    throw new Error(
      `the deploy record is incomplete (missing ${missing.join(', ')}) — it predates this command or the deploy died very early. ` +
        'Deploy again with `agentbox hub deploy hetzner`.',
    );
  }
}

export interface HetznerUpdateOptions {
  envPath: string;
  /** The build to move to. */
  source: HubDeploySource;
  log: (line: string) => void;
}

/**
 * Update the control box recorded in `deploy.json` in place, then record the new
 * build. The record is written only on success — a failed update leaves the
 * previous `source` in place, which is what the VPS is still running.
 */
export async function runHetznerUpdate(opts: HetznerUpdateOptions): Promise<{ url: string }> {
  if (readHetznerCredStatus().source === 'none') {
    throw new Error('no HCLOUD_TOKEN configured — run `agentbox hetzner login` first');
  }
  const record = await readDeployRecord();
  assertReachableRecord(record);
  const envContent = await readFile(opts.envPath, 'utf8');
  await updateControlPlaneOnHetzner({
    record: {
      ip: record.ip,
      sshKeyDir: record.sshKeyDir,
      url: record.url,
      ...(record.domain ? { domain: record.domain } : {}),
      // Hetzner firewall ids are numeric; the shared record widened to number|string
      // for DigitalOcean, so narrow here (a hetzner record never carries a string).
      ...(typeof record.firewallId === 'number' ? { firewallId: record.firewallId } : {}),
    },
    source: opts.source,
    envContent,
    onLog: opts.log,
  });
  await persistDeployRecord({ ...record, source: opts.source });
  return { url: record.url };
}

/**
 * Delete the control box's Hetzner resources. The local state is purged by the
 * caller afterwards — deliberately separate, so a partial cloud teardown still
 * lets the user clear config that now points at nothing.
 */
export async function runHetznerDestroy(opts: {
  record: ControlPlaneDeployRecord;
  log: (line: string) => void;
}): Promise<ControlPlaneDestroyResult> {
  if (readHetznerCredStatus().source === 'none') {
    throw new Error('no HCLOUD_TOKEN configured — run `agentbox hetzner login` first');
  }
  return destroyControlPlaneOnHetzner({
    ...(opts.record.serverId !== undefined ? { serverId: opts.record.serverId } : {}),
    ...(typeof opts.record.firewallId === 'number' ? { firewallId: opts.record.firewallId } : {}),
    onLog: opts.log,
  });
}

/**
 * Drop the local trace of a control box: the deploy record + its per-deploy ssh
 * key, and (unless kept) the credentials `hub setup` wrote. Refreshes the
 * managed ssh config so the `agentbox-hub` alias disappears with the record.
 */
export async function purgeLocalControlPlaneState(opts: {
  dir: string;
  keepCredentials: boolean;
}): Promise<void> {
  if (opts.keepCredentials) {
    await rm(controlPlaneDeployPath(), { force: true });
    await rm(join(opts.dir, 'ssh'), { recursive: true, force: true });
  } else {
    await rm(opts.dir, { recursive: true, force: true });
  }
  try {
    const cfg = await loadEffectiveConfig(homedir());
    if (cfg.effective.ssh.autoConfig) await syncAgentboxSshConfig();
  } catch {
    // Best-effort, exactly as when the record is written.
  }
}
