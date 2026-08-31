import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ControlPlaneDeployRecord, type HubDeploySource } from '@agentbox/sandbox-core';
import {
  deployControlPlaneToDigitalOcean,
  destroyControlPlaneOnDigitalOcean,
  readDigitalOceanCredStatus,
  updateControlPlaneOnDigitalOcean,
  type ControlPlaneDestroyResult,
} from '@agentbox/sandbox-digitalocean';
import { assertReachableRecord, persistDeployRecord, readDeployRecord } from './deploy-hetzner.js';

/**
 * CLI wrapper for the DigitalOcean control-plane deploy: precheck the token, run
 * the provisioning in `@agentbox/sandbox-digitalocean`, and persist the deploy
 * record so a later command (or the user) can find / tear down the Droplet.
 *
 * The deploy-record + ssh-config bookkeeping (`persistDeployRecord`,
 * `readDeployRecord`, `assertReachableRecord`) is provider-agnostic and shared
 * with the Hetzner wrapper — only the provider-specific provisioning differs.
 */
export interface DigitalOceanDeployOptions {
  /** Path to the setup-written control-plane.env (scp'd to the Droplet as `.env`). */
  envPath: string;
  /** Where the Droplet gets the hub from — the npm package, or a cloned ref. */
  source: HubDeploySource;
  /**
   * Serve on a hostname you control instead of the default `<ip>.sslip.io`. Point
   * its DNS at the Droplet first — Caddy proves ownership over HTTP-01, so a name
   * that doesn't resolve to this machine never gets a certificate.
   */
  domain?: string;
  /** DigitalOcean region slug (default nyc3). */
  region?: string;
  /** Droplet size slug (default s-2vcpu-4gb). */
  size?: string;
  log: (line: string) => void;
  /**
   * Fired once the Droplet exists, before the build + healthz poll. Lets the
   * caller report how to reach the machine when a later step fails — the droplet
   * is not torn down, so it is inspectable (and billable) either way.
   */
  onProvisioned?: (info: ControlPlaneDeployRecord) => void;
}

export async function runDigitalOceanDeploy(
  opts: DigitalOceanDeployOptions,
): Promise<{ url: string }> {
  if (readDigitalOceanCredStatus().source === 'none') {
    throw new Error('no DIGITALOCEAN_TOKEN configured — run `agentbox digitalocean login` first');
  }
  const envContent = await readFile(opts.envPath, 'utf8');
  const result = await deployControlPlaneToDigitalOcean({
    envContent,
    source: opts.source,
    ...(opts.domain ? { domain: opts.domain } : {}),
    ...(opts.region ? { region: opts.region } : {}),
    ...(opts.size ? { size: opts.size } : {}),
    onLog: opts.log,
    onProvisioned: async (info) => {
      const record: ControlPlaneDeployRecord = {
        provider: 'digitalocean',
        source: opts.source,
        ...info,
      };
      opts.onProvisioned?.(record);
      await persistDeployRecord(record);
    },
  });
  await persistDeployRecord({ provider: 'digitalocean', source: opts.source, ...result });
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
    `The Droplet is still running (droplet ${String(record.serverId ?? '?')}, ${record.ip ?? '?'}) — inspect it:`,
    `  ssh agentbox-hub`,
    ...(key ? [`  (or: ssh -i ${key} root@${record.ip ?? '?'})`] : []),
    `  cd /opt/agentbox/apps/hub && docker compose ${files} logs --tail=200 app`,
    `SSH is firewalled to this machine's egress IP, so run it from here.`,
    `Retry the deploy with \`agentbox hub deploy digitalocean\` (reuses the same env).`,
  ];
}

export interface DigitalOceanUpdateOptions {
  envPath: string;
  /** The build to move to. */
  source: HubDeploySource;
  log: (line: string) => void;
}

/**
 * Update the control box recorded in `deploy.json` in place, then record the new
 * build. The record is written only on success — a failed update leaves the
 * previous `source` in place, which is what the Droplet is still running.
 */
export async function runDigitalOceanUpdate(
  opts: DigitalOceanUpdateOptions,
): Promise<{ url: string }> {
  if (readDigitalOceanCredStatus().source === 'none') {
    throw new Error('no DIGITALOCEAN_TOKEN configured — run `agentbox digitalocean login` first');
  }
  const record = await readDeployRecord();
  assertReachableRecord(record);
  const envContent = await readFile(opts.envPath, 'utf8');
  await updateControlPlaneOnDigitalOcean({
    record: {
      ip: record.ip,
      sshKeyDir: record.sshKeyDir,
      url: record.url,
      ...(record.domain ? { domain: record.domain } : {}),
      // DigitalOcean firewall ids are UUID strings; the shared record widened to
      // number|string, so narrow here (a DO record never carries a number).
      ...(typeof record.firewallId === 'string' ? { firewallId: record.firewallId } : {}),
    },
    source: opts.source,
    envContent,
    onLog: opts.log,
  });
  await persistDeployRecord({ ...record, source: opts.source });
  return { url: record.url };
}

/**
 * Delete the control box's DigitalOcean resources. The local state is purged by
 * the caller afterwards — deliberately separate, so a partial cloud teardown
 * still lets the user clear config that now points at nothing.
 */
export async function runDigitalOceanDestroy(opts: {
  record: ControlPlaneDeployRecord;
  log: (line: string) => void;
}): Promise<ControlPlaneDestroyResult> {
  if (readDigitalOceanCredStatus().source === 'none') {
    throw new Error('no DIGITALOCEAN_TOKEN configured — run `agentbox digitalocean login` first');
  }
  return destroyControlPlaneOnDigitalOcean({
    ...(opts.record.serverId !== undefined ? { serverId: opts.record.serverId } : {}),
    ...(typeof opts.record.firewallId === 'string' ? { firewallId: opts.record.firewallId } : {}),
    ...(opts.record.firewallTag ? { firewallTag: opts.record.firewallTag } : {}),
    onLog: opts.log,
  });
}
