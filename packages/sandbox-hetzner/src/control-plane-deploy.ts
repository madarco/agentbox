/**
 * Deploy the AgentBox hosted control plane (the `apps/hub` Next.js +
 * Postgres app) to a fresh Hetzner VPS, reachable over HTTPS at
 * `https://<ipv4>.sslip.io` (sslip.io resolves the host to the IP; Caddy auto-
 * provisions a Let's Encrypt cert — no domain or DNS setup needed).
 *
 * Shape:
 *   1. firewall — SSH from the host egress IP, :80/:443 open (ACME + serving).
 *   2. cloud-init — stock Ubuntu boots, installs Docker + git, clones the repo.
 *   3. over ssh (as root): scp the secret `.env` + a Caddy compose overlay, then
 *      `docker compose up -d --build` (Postgres + the app + Caddy, all in-compose).
 *   4. poll `https://<domain>/healthz` until the cert + app are live.
 * Secrets ride scp (per-deploy key), never cloud-init user-data (cloud metadata).
 */

import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHetznerClient, type HetznerServer } from './client.js';
import { controlPlaneCloudInit } from './cloud-init.js';
import { detectEgressIp } from './egress-ip.js';
import { controlPlaneInboundRules, normalizeSourceCidr } from './firewall.js';
import { mintSshKey } from './ssh-key.js';
import { scpUpload, sshExec, waitForSsh, type SshTargetArgs } from './ssh-cli.js';
import { withHetznerRetry } from './retry.js';

export interface ControlPlaneHetznerDeployOptions {
  /** Contents of `control-plane.env` — GITHUB_APP_ID / _PRIVATE_KEY / ADMIN_TOKEN. */
  envContent: string;
  /** Override the public hostname (default `<ipv4>.sslip.io`). */
  domain?: string;
  /** Public git repo cloned on the VPS (default the agentbox repo). */
  repoUrl?: string;
  /** Branch / tag / sha to deploy (default `main`). */
  repoRef?: string;
  serverType?: string;
  location?: string;
  serverImage?: string;
  onLog?: (line: string) => void;
}

export interface ControlPlaneHetznerDeployResult {
  url: string;
  serverId: number;
  ip: string;
  domain: string;
  firewallId: number;
  sshKeyDir: string;
}

const REMOTE_APP_DIR = '/opt/agentbox/apps/hub';
// Host bind-mounted into the app container at /root/.agentbox: store.db, auth.db,
// custody/, boxes/<id>/ssh, secrets.env (provider creds), logs. Persists the hub
// across `compose up` / VPS reboots.
const REMOTE_DATA_DIR = '/opt/agentbox/hub-data';

// Provider credentials the resident worker needs to provision cloud boxes. Only
// these keys are copied from the host `~/.agentbox/secrets.env` — never the whole
// file (it may hold unrelated secrets). Keep this in sync with `PROVIDER_CRED_KEYS`
// in apps/hub (the "configured" badge) + each provider module's managed keys — a
// key here that isn't copied shows the provider "not configured" on the control box.
const PROVIDER_SECRET_KEYS = [
  'HCLOUD_TOKEN',
  'E2B_API_KEY',
  'DAYTONA_API_KEY',
  'DAYTONA_JWT_TOKEN',
  'DAYTONA_ORG_ID',
  // Vercel: only the ACCESS-TOKEN keys travel. A CLI-login setup keeps the token
  // in the Vercel CLI store (not secrets.env) and marks it with
  // VERCEL_AUTH_SOURCE — deliberately NOT copied, since there's no vercel CLI on
  // the control box, so copying the marker without a token would falsely show
  // "configured" and then fail at create time. Set a VERCEL_TOKEN (or use the hub
  // Settings form) to run vercel from the control box.
  'VERCEL_TOKEN',
  'VERCEL_OIDC_TOKEN',
  'VERCEL_TEAM_ID',
  'VERCEL_PROJECT_ID',
  'DIGITALOCEAN_TOKEN',
  'DIGITALOCEAN_API_URL',
];

/** Extract just the provider-credential lines from the host `~/.agentbox/secrets.env`. */
async function collectProviderSecrets(): Promise<string> {
  let body = '';
  try {
    body = await readFile(join(homedir(), '.agentbox', 'secrets.env'), 'utf8');
  } catch {
    return '';
  }
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const stripped = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (PROVIDER_SECRET_KEYS.includes(key)) out.push(`${key}=${stripped.slice(eq + 1)}`);
  }
  return out.length > 0 ? out.join('\n') + '\n' : '';
}

function caddyfile(domain: string): string {
  // Caddy auto-provisions a Let's Encrypt cert for the site address and reverse-
  // proxies to the Next app on the compose network (the app listens on :8787).
  return `${domain} {\n\treverse_proxy app:8787\n}\n`;
}

const CADDY_COMPOSE = `services:
  caddy:
    image: caddy:2.8
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ${REMOTE_APP_DIR}/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - app
volumes:
  caddy_data:
  caddy_config:
`;

async function serverIpv4(
  client: ReturnType<typeof makeHetznerClient>,
  server: HetznerServer,
  deadlineMs: number,
): Promise<string> {
  if (server.public_net.ipv4?.ip) return server.public_net.ipv4.ip;
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) {
    const s = await client.getServer(server.id);
    if (s?.public_net.ipv4?.ip) return s.public_net.ipv4.ip;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`server ${String(server.id)} never got a public IPv4`);
}

async function pollHealthz(url: string, deadlineMs: number, log: (l: string) => void): Promise<void> {
  const stop = Date.now() + deadlineMs;
  let lastErr = '';
  while (Date.now() < stop) {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return;
      lastErr = `HTTP ${String(res.status)}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.name : String(e);
    }
    log(`waiting for ${url}/healthz (cert + app)… ${lastErr}`);
    await new Promise((r) => setTimeout(r, 6_000));
  }
  throw new Error(`control plane did not become healthy at ${url} (${lastErr})`);
}

export async function deployControlPlaneToHetzner(
  opts: ControlPlaneHetznerDeployOptions,
): Promise<ControlPlaneHetznerDeployResult> {
  const log = opts.onLog ?? (() => {});
  const repoUrl = opts.repoUrl ?? 'https://github.com/madarco/agentbox.git';
  const repoRef = opts.repoRef ?? 'main';
  const client = makeHetznerClient();

  const stamp = Date.now().toString(36);
  const name = `agentbox-control-plane-${stamp}`;

  log('detecting host egress IP for the firewall…');
  const hostCidr = normalizeSourceCidr(await detectEgressIp());

  log('creating the control-plane firewall (:22 host-only, :80/:443 open)…');
  // retryOnAmbiguous: true — a firewall is free and per-deploy-uniquely named,
  // so a retry after a hidden success leaves at most a harmless orphan; unlike
  // the server create below (billable), a transient 502/504/429 must not abort
  // the deploy on its very first step.
  const firewall = await withHetznerRetry(
    { method: 'createFirewall', retryOnAmbiguous: true, attemptTimeoutMs: 60_000 },
    () =>
      client.createFirewall({
        name,
        rules: controlPlaneInboundRules(hostCidr),
        labels: { 'agentbox.managed': 'true', 'agentbox.role': 'control-plane' },
      }),
  );

  const keyDir = join(homedir(), '.agentbox', 'control-plane', 'ssh', stamp);
  const key = await mintSshKey(keyDir, `agentbox-control-plane-${stamp}`);
  const knownHosts = join(keyDir, 'known_hosts');

  log(`provisioning ${opts.serverType ?? 'cx23'} VPS (cloning ${repoUrl}@${repoRef})…`);
  const { server } = await withHetznerRetry(
    { method: 'createServer', retryOnAmbiguous: false, attemptTimeoutMs: 120_000 },
    () =>
      client.createServer({
        name,
        server_type: opts.serverType ?? 'cx23',
        image: opts.serverImage ?? 'ubuntu-24.04',
        location: opts.location ?? 'nbg1',
        user_data: controlPlaneCloudInit({ sshPubkey: key.publicKey, repoUrl, repoRef }),
        firewalls: [{ firewall: firewall.id }],
        labels: { 'agentbox.managed': 'true', 'agentbox.role': 'control-plane' },
        start_after_create: true,
      }),
  );

  const ip = await serverIpv4(client, server, 60_000);
  const domain = opts.domain ?? `${ip}.sslip.io`;
  const url = `https://${domain}`;
  const target: SshTargetArgs = { host: ip, user: 'root', identity: key.privatePath, knownHosts };

  log(`VPS ${ip} up; waiting for ssh…`);
  if (!(await waitForSsh(target, 5 * 60_000))) {
    throw new Error(`ssh never came up on ${ip}`);
  }
  log('waiting for cloud-init (Docker + repo clone)…');
  await sshExec(target, 'cloud-init status --wait || true', { timeoutMs: 12 * 60_000, onLine: log });
  const cloned = await sshExec(target, `test -d ${REMOTE_APP_DIR}`);
  if (cloned.exitCode !== 0) {
    throw new Error('repo clone did not complete on the VPS (cloud-init failed)');
  }

  // The full-hub compose keys the deploy adds on top of the App/auth env:
  //  - the persistent data dir (bind-mounted at /root/.agentbox),
  //  - the public URL a hub-created box registers against (control-plane topology),
  //  - the admin PC egress CIDR (== this deploying machine) added to a hetzner
  //    box's firewall so the PC can still SSH direct (phase 4).
  const hubEnvExtra =
    `AGENTBOX_HUB_DATA_DIR=${REMOTE_DATA_DIR}\n` +
    `AGENTBOX_HUB_PUBLIC_URL=${url}\n` +
    `AGENTBOX_HUB_ADMIN_CIDR=${hostCidr}\n`;
  const providerSecrets = await collectProviderSecrets();
  if (!providerSecrets) {
    log('warning: no provider credentials found in ~/.agentbox/secrets.env — the worker can only create boxes for providers whose creds you push later');
  }

  // Stage the secret env + Caddy config locally, then scp them up.
  const staging = join(tmpdir(), `agentbox-cp-deploy-${stamp}`);
  await mkdir(staging, { recursive: true });
  try {
    const envLocal = join(staging, 'control-plane.env');
    const caddyLocal = join(staging, 'Caddyfile');
    const composeLocal = join(staging, 'docker-compose.caddy.yml');
    const secretsLocal = join(staging, 'secrets.env');
    await writeFile(envLocal, opts.envContent + hubEnvExtra, { mode: 0o600 });
    await writeFile(caddyLocal, caddyfile(domain));
    await writeFile(composeLocal, CADDY_COMPOSE);
    await writeFile(secretsLocal, providerSecrets, { mode: 0o600 });
    log('creating the persistent data dir on the VPS…');
    await sshExec(target, `mkdir -p ${REMOTE_DATA_DIR} && chmod 700 ${REMOTE_DATA_DIR}`);
    log('uploading env + provider secrets + Caddy config…');
    await scpUpload(target, envLocal, `${REMOTE_APP_DIR}/.env`);
    await scpUpload(target, caddyLocal, `${REMOTE_APP_DIR}/Caddyfile`);
    await scpUpload(target, composeLocal, `${REMOTE_APP_DIR}/docker-compose.caddy.yml`);
    // Provider creds live in the data volume (read as ~/.agentbox/secrets.env),
    // NOT in the compose env — so they're never in `docker inspect`/compose logs.
    await scpUpload(target, secretsLocal, `${REMOTE_DATA_DIR}/secrets.env`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  log('building + starting the control plane (docker compose up --build)…');
  const up = await sshExec(
    target,
    `cd ${REMOTE_APP_DIR} && docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d --build`,
    { timeoutMs: 25 * 60_000, onLine: log },
  );
  if (up.exitCode !== 0) {
    throw new Error(`docker compose up failed (exit ${String(up.exitCode)}): ${up.stderr || up.stdout}`);
  }

  log(`provisioned; waiting for HTTPS at ${url} …`);
  await pollHealthz(url, 3 * 60_000, log);

  const result: ControlPlaneHetznerDeployResult = {
    url,
    serverId: server.id,
    ip,
    domain,
    firewallId: firewall.id,
    sshKeyDir: keyDir,
  };
  return result;
}
