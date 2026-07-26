/**
 * Deploy the AgentBox hosted control plane (the `apps/hub` Next.js +
 * Postgres app) to a fresh Hetzner VPS, reachable over HTTPS at
 * `https://<ipv4>.sslip.io` (sslip.io resolves the host to the IP; Caddy auto-
 * provisions a Let's Encrypt cert — no domain or DNS setup needed).
 *
 * Shape:
 *   1. firewall — SSH from the host egress IP, :80/:443 open (ACME + serving).
 *   2. cloud-init — stock Ubuntu boots, installs Docker + git (+ clones the repo
 *      in source mode).
 *   3. over ssh (as root): scp the secret `.env` + a Caddy compose overlay (+ the
 *      whole compose stack in package mode), then `docker compose up -d --build`
 *      (the app + Caddy, all in-compose).
 *   4. poll `https://<domain>/healthz` until the cert + app are live.
 * Secrets ride scp (per-deploy key), never cloud-init user-data (cloud metadata).
 *
 * The hub image comes from one of two places — see `HubDeploySource`. The default
 * installs the published npm package; `--ref` clones and builds the monorepo.
 */

import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEffectiveConfig, mergeConfigYaml } from '@agentbox/config';
import type { HubDeploySource } from '@agentbox/sandbox-core';
import { makeHetznerClient, type HetznerClient, type HetznerServer } from './client.js';
import { controlPlaneCloudInit } from './cloud-init.js';
import { detectEgressIp } from './egress-ip.js';
import { controlPlaneInboundRules, firewallNeedsSync, normalizeSourceCidr } from './firewall.js';
import { resolveHubDeployAssets } from './hub-deploy-assets.js';
import { mintSshKey } from './ssh-key.js';
import { scpUpload, sshExec, waitForSsh, type SshTargetArgs } from './ssh-cli.js';
import { withHetznerRetry } from './retry.js';

export interface ControlPlaneHetznerDeployOptions {
  /** Contents of `control-plane.env` — GITHUB_APP_ID / _PRIVATE_KEY / ADMIN_TOKEN. */
  envContent: string;
  /** Override the public hostname (default `<ipv4>.sslip.io`). */
  domain?: string;
  /** npm package vs. clone-and-build. See `HubDeploySource`. */
  source: HubDeploySource;
  serverType?: string;
  location?: string;
  serverImage?: string;
  onLog?: (line: string) => void;
  /**
   * Fired as soon as the VPS exists and its IP + SSH key are known — BEFORE the
   * ssh wait, the compose build, and the healthz poll, all of which routinely
   * fail. Everything after this point is debuggable only by getting INTO the
   * VPS, so the caller must be able to persist the connection details before
   * they can be lost. The server + firewall are not rolled back on failure.
   */
  onProvisioned?: (info: ControlPlaneHetznerDeployResult) => void | Promise<void>;
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
// The monorepo checkout cloud-init makes in source mode — the parent of
// REMOTE_APP_DIR, and what `hub update --ref` re-checks-out. Absent entirely in
// package mode, where nothing on the VPS comes from git.
const REMOTE_REPO_DIR = '/opt/agentbox';

/** Single-quote a value for a remote `sh -c` command line. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
// Host bind-mounted into the app container at /root/.agentbox: store.db, auth.db,
// custody/, boxes/<id>/ssh, secrets.env (provider creds), logs. Persists the hub
// across `compose up` / VPS reboots.
const REMOTE_DATA_DIR = '/opt/agentbox/hub-data';

// Provider credentials the resident worker needs to provision cloud boxes. Only
// these keys are copied from the host `~/.agentbox/secrets.env` — never the whole
// file (it may hold unrelated secrets). This is the exact set each provider's
// `env-loader.ts` reads (`E2B_KEYS`/`HETZNER_KEYS`/`DAYTONA_KEYS`/`VERCEL_KEYS`/
// `DIGITALOCEAN_KEYS`) MINUS `VERCEL_AUTH_SOURCE` (see below) — that's the source
// of truth; `test/provider-secret-keys.test.ts` fails if this drifts from it (it
// once carried `DAYTONA_ORG_ID`, but the real key is `DAYTONA_ORGANIZATION_ID`, so
// JWT-mode Daytona shipped with no org id and failed at create). The parallel
// `PROVIDER_CRED_KEYS` in apps/hub (the "configured" badge) is a required-key
// subset of this; a key missing here shows the provider "not configured" remotely.
export const PROVIDER_SECRET_KEYS = [
  'HCLOUD_TOKEN',
  'HCLOUD_ENDPOINT',
  'E2B_API_KEY',
  'E2B_DOMAIN',
  'DAYTONA_API_KEY',
  'DAYTONA_JWT_TOKEN',
  'DAYTONA_ORGANIZATION_ID',
  'DAYTONA_API_URL',
  'DAYTONA_TARGET',
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
] as const;

/**
 * Split the hub's GitHub token out of the compose `.env`.
 *
 * `hub setup --git-auth gh` writes `GH_TOKEN` into `control-plane.env`, but that
 * file becomes the compose env-file — and a compose `environment:` value is
 * readable via `docker inspect` and shows up in compose logs. The deploy already
 * routes provider credentials to the data-volume `secrets.env` for exactly this
 * reason, so the git token rides along with them instead.
 *
 * Returns the remaining env body and the extracted token (if any). Pure.
 */
export function splitHubGitToken(envContent: string): { env: string; token: string | null } {
  const kept: string[] = [];
  let token: string | null = null;
  for (const line of envContent.split(/\r?\n/)) {
    const m = /^(?:export\s+)?GH_TOKEN=(.*)$/.exec(line.trim());
    if (m) {
      const value = m[1]?.trim() ?? '';
      if (value.length > 0) token = value;
      continue;
    }
    kept.push(line);
  }
  return { env: kept.join('\n'), token };
}

/** Filter a `secrets.env` body down to just the allowlisted provider-cred lines. Pure — unit-testable. */
export function filterProviderSecrets(body: string): string {
  const allow = new Set<string>(PROVIDER_SECRET_KEYS);
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const stripped = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (allow.has(key)) out.push(`${key}=${stripped.slice(eq + 1)}`);
  }
  return out.length > 0 ? out.join('\n') + '\n' : '';
}

/**
 * Config keys migrated to the control box's own `config.yaml`.
 *
 * Only `box.claudeInstall` so far, and it earns its place: it selects how
 * `prepare` installs Claude Code, and `npm` exists specifically because the
 * native installer intermittently Cloudflare-403s datacenter egress IPs — which
 * is exactly what a control box has. Without migrating it, a control box that
 * bakes its own base picks the mode most likely to fail there.
 *
 * Deliberately NOT the whole config: most keys are host-specific (paths,
 * terminal integration) and would be wrong or meaningless on the VPS.
 */
const MIGRATED_CONFIG_KEYS = ['box.claudeInstall'] as const;

/**
 * The control box's config, with the migrated keys merged into whatever is
 * already there. Returns null when there is nothing to change.
 *
 * Merges rather than overwrites because the hub writes this same file itself
 * (`box.remoteDockerHost`, via the Settings UI) — regenerating it on a redeploy
 * would silently drop that. `remoteBody` is the VPS's current file ('' if none).
 */
export function buildControlPlaneConfigYaml(
  remoteBody: string,
  values: Partial<Record<(typeof MIGRATED_CONFIG_KEYS)[number], unknown>>,
): string | null {
  let body = remoteBody;
  let changed = false;
  for (const key of MIGRATED_CONFIG_KEYS) {
    const value = values[key];
    if (value === undefined) continue;
    body = mergeConfigYaml(body, key, value);
    changed = true;
  }
  return changed ? body : null;
}

/**
 * The PC's global effective values for the migrated keys. Global (not the cwd
 * project's) because the control box is project-independent, and because the hub
 * itself reads global when deciding what to bake — keeping the two symmetric.
 *
 * A key already at its default is omitted: nothing to migrate, and no reason to
 * create a config file on the VPS that wasn't there.
 */
async function collectMigratedConfig(): Promise<Partial<Record<string, unknown>>> {
  try {
    const cfg = await loadEffectiveConfig(homedir());
    const out: Record<string, unknown> = {};
    if (cfg.effective.box.claudeInstall === 'npm') out['box.claudeInstall'] = 'npm';
    return out;
  } catch {
    return {};
  }
}

/** Extract just the provider-credential lines from the host `~/.agentbox/secrets.env`. */
async function collectProviderSecrets(): Promise<string> {
  let body = '';
  try {
    body = await readFile(join(homedir(), '.agentbox', 'secrets.env'), 'utf8');
  } catch {
    return '';
  }
  return filterProviderSecrets(body);
}

function caddyfile(domain: string, appPort: number): string {
  // Caddy auto-provisions a Let's Encrypt cert for the site address and reverse-
  // proxies to the hub on the compose network. `appPort` is the port the DEPLOYED
  // ref's container actually listens on — hardcoding this CLI's port made a
  // cross-version deploy 502 forever against a healthy hub.
  return `${domain} {\n\treverse_proxy app:${String(appPort)}\n}\n`;
}

/** Fallback when the compose can't be parsed — the port this CLI's hub listens on. */
const HUB_CONTAINER_PORT = 8787;

/**
 * The `-f` list for every `docker compose` call against the control box. Package
 * mode layers `docker-compose.package.yml` between the base and the Caddy overlay
 * to swap the `app` service's build block; everything else is shared, which is
 * what keeps the two modes from drifting. Must match between `up` and the
 * diagnostics — a mismatched list makes compose treat it as a different project.
 */
function composeFileArgs(source: HubDeploySource): string {
  const files = ['docker-compose.yml'];
  if (source.kind === 'package') files.push('docker-compose.package.yml');
  files.push('docker-compose.caddy.yml');
  return files.map((f) => `-f ${f}`).join(' ');
}

/**
 * The container port `apps/hub/docker-compose.yml` publishes 8787 to — i.e. the
 * port the hub listens on INSIDE its container, which is what Caddy has to dial
 * over the compose network.
 *
 * It moved (`8787:3000` on the Next-only hub, `8787:8787` on the full hub), so
 * the deploy reads it from the ref it is actually deploying instead of assuming.
 * Pure — unit-testable.
 */
export function hubContainerPort(composeYaml: string): number | undefined {
  // `- '8787:3000'` / `- "8787:8787"` / `- 8787:8787`, optionally IP-prefixed.
  const m = /^\s*-\s*['"]?(?:[\d.]+:)?8787:(\d+)['"]?\s*$/m.exec(composeYaml);
  const port = m?.[1] === undefined ? NaN : Number(m[1]);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/**
 * Whether a cloned ref's compose is the FULL hub this deploy knows how to wire.
 *
 * `AGENTBOX_HUB_DATA_DIR` is the tell: the deploy creates that host directory,
 * scp's provider secrets into it, and passes it through `.env` expecting the
 * compose to bind-mount it at `/root/.agentbox`. A ref that predates the full
 * hub ignores the key entirely, so the deploy's state (and its Postgres-vs-SQLite
 * assumption) silently doesn't apply. Fail fast instead of building for 20
 * minutes and serving something subtly wrong.
 */
export function isFullHubCompose(composeYaml: string): boolean {
  return composeYaml.includes('AGENTBOX_HUB_DATA_DIR');
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

async function pollHealthz(
  url: string,
  deadlineMs: number,
  log: (l: string) => void,
  diagnose?: () => Promise<string>,
): Promise<void> {
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
  // "HTTP 502 for 3 minutes" says nothing about which of the three layers
  // (Caddy, the proxy hop, the hub) is broken. We still hold the ssh key, so ask
  // the VPS directly before giving up.
  const detail = diagnose ? await diagnose().catch(() => '') : '';
  throw new Error(
    `control plane did not become healthy at ${url} (${lastErr})${detail ? `\n${detail}` : ''}`,
  );
}

/**
 * Explain a failing healthz when the hub itself is fine, from what an HTTPS
 * request made ON the VPS returned. `curl -w '%{http_code}'` prints `000` when it
 * never got a response at all, which is the decisive signal:
 *
 *   - `200`   — certificate AND upstream both work locally, so the break is
 *               between this machine and the domain (DNS, or the :443 rule).
 *   - `000`   — the TLS handshake never completed: no usable certificate.
 *   - other   — Caddy answered, so TLS is fine and the reverse-proxy upstream is wrong.
 *
 * Deliberately NOT inferred from Caddy's log text: `tls.obtain` and `certificate`
 * appear in its SUCCESS lines too ("obtaining certificate", "lock acquired",
 * "served key authentication certificate"), so a healthy certificate plus a real
 * upstream mismatch would be reported as a certificate problem. The log is only
 * read for the rate-limit *detail*, which has an unambiguous error signature.
 *
 * Pure — the ssh calls happen in `diagnoseUnhealthy`, so this stays unit-testable.
 */
export function describeCaddyHop(
  httpCode: string,
  caddyLog: string,
  appPort: number,
  domain: string,
): string {
  const code = httpCode.trim();
  const healthy = 'the hub IS healthy on the VPS (127.0.0.1:8787 answered)';
  if (code === '200') {
    return (
      `${healthy}, and so is Caddy — an HTTPS request made ON the VPS returned 200. ` +
      `The break is between this machine and ${domain}: check that the name resolves to the VPS ` +
      `and that the firewall still allows :443.`
    );
  }
  if (code !== '000' && /^\d{3}$/.test(code)) {
    return (
      `${healthy} and its certificate works, but Caddy answered ${code} — ` +
      `its upstream (app:${String(appPort)}) does not match what the container listens on. ` +
      `Check \`docker compose ps\` on the VPS and redeploy with a ref matching this CLI.`
    );
  }
  // No HTTP response at all → the TLS handshake never completed → no certificate.
  const rateLimited = /rateLimited/.test(caddyLog);
  return (
    `${healthy} — the HTTPS certificate is the problem, not the hub.\n` +
    (rateLimited
      ? `Let's Encrypt is rate-limiting this exact hostname (sslip.io derives it from the IP, and this address has hit the 5-certs-per-week cap — likely a recycled IP). Destroy this VPS and deploy again to get a different IP, or pass --domain with a name you control.\n`
      : `Caddy has no usable certificate yet. Check that :80 and :443 are reachable from the internet.\n`) +
    `--- caddy (cert lines) ---\n${caddyLog.trim()}`
  );
}

/**
 * Read a failing healthz back to the user as a specific cause. The hub answering
 * on the VPS's own port but not through HTTPS used to be reported as a single
 * "Caddy can't reach it → wrong upstream port" guess, which is wrong whenever the
 * certificate is the problem — and it routinely is: sslip.io names are derived
 * from the IP, so a recycled Hetzner address can arrive already at Let's Encrypt's
 * per-identifier rate limit, through no fault of the deploy.
 */
async function diagnoseUnhealthy(
  target: SshTargetArgs,
  appPort: number,
  source: HubDeploySource,
  domain: string,
): Promise<string> {
  const files = composeFileArgs(source);
  const local = await sshExec(target, `curl -fsS -m 5 http://127.0.0.1:8787/healthz`);
  if (local.exitCode === 0) {
    // The hub is fine, so the failure is Caddy's hop. Ask the VPS itself rather
    // than guessing from logs: --resolve pins the name to loopback, so this
    // exercises the real certificate and the real reverse_proxy upstream.
    const probe = await sshExec(
      target,
      `curl -sk -o /dev/null -w '%{http_code}' -m 10 --resolve ${domain}:443:127.0.0.1 https://${domain}/healthz || true`,
    );
    const caddy = await sshExec(
      target,
      `cd ${REMOTE_APP_DIR} && docker compose ${files} logs --tail=200 caddy 2>&1 | grep -E 'tls\\.obtain|certificate|rateLimited' | tail -8`,
    );
    return describeCaddyHop(probe.stdout, caddy.stdout, appPort, domain);
  }
  const ps = await sshExec(target, `cd ${REMOTE_APP_DIR} && docker compose ${files} ps`);
  const logs = await sshExec(
    target,
    `cd ${REMOTE_APP_DIR} && docker compose ${files} logs --tail=30 app 2>&1`,
  );
  return `the hub is NOT answering on the VPS either.\n${ps.stdout.trim()}\n--- app logs (last 30) ---\n${logs.stdout.trim()}`;
}

export interface ApplyControlPlaneOptions {
  /** An ssh target for a VPS that is already up and reachable. */
  target: SshTargetArgs;
  source: HubDeploySource;
  /** Contents of `control-plane.env` (the App/auth/token secrets). */
  envContent: string;
  /** Public base URL the hub serves on, e.g. `https://<ip>.sslip.io`. */
  url: string;
  /** Hostname inside that URL — the Caddy site address. */
  domain: string;
  /** This machine's egress CIDR (admin SSH allowance the hub passes to its boxes). */
  hostCidr: string;
  /** Unique-ish suffix for the local staging dir. */
  stamp: string;
  /**
   * Fail when source mode finds no repo at REMOTE_APP_DIR. True on a fresh
   * deploy (a missing clone means cloud-init failed); false on an update, where
   * the caller has already checked out the ref itself.
   */
  requireClonedRepo?: boolean;
  onLog?: (line: string) => void;
}

/**
 * Configure and (re)start the hub on a VPS that already exists: ship the compose
 * stack, generate `.env` + the Caddyfile, push provider secrets and migrated
 * config, `docker compose up -d --build`, and wait for public HTTPS.
 *
 * Split out of the deploy because an **update** has to redo every one of these:
 * a new version can add `.env` keys, move the container port Caddy proxies to,
 * and ship new compose/Dockerfile assets. Running the same code for both is what
 * keeps `hub update` from drifting away from `hub deploy`.
 */
export async function applyControlPlaneConfig(opts: ApplyControlPlaneOptions): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const { target, source, url, domain, hostCidr, stamp } = opts;
  const deployAssets = source.kind === 'package' ? resolveHubDeployAssets() : null;

  // The compose the `app` service is built from. In package mode the host owns
  // it (it travels with the deploy, below); in source mode it comes from the ref
  // checked out on the VPS, so anything version-dependent has to be read from
  // THERE rather than assumed — the host only generates the Caddyfile and `.env`.
  let compose: string;
  if (deployAssets) {
    await sshExec(target, `mkdir -p ${REMOTE_APP_DIR}`);
    compose = await readFile(deployAssets['docker-compose.yml'], 'utf8');
  } else {
    const cloned = await sshExec(target, `test -d ${REMOTE_APP_DIR}`);
    if (cloned.exitCode !== 0 && opts.requireClonedRepo) {
      throw new Error('repo clone did not complete on the VPS (cloud-init failed)');
    }
    if (cloned.exitCode !== 0) {
      throw new Error(
        `no repo checkout at ${REMOTE_APP_DIR} on the VPS — this control box was not deployed from source, so it cannot be updated to a --ref. Deploy a new one, or update it to a published version instead.`,
      );
    }
    const composeBody = await sshExec(target, `cat ${REMOTE_APP_DIR}/docker-compose.yml`);
    compose = composeBody.exitCode === 0 ? composeBody.stdout : '';
    if (compose && !isFullHubCompose(compose)) {
      throw new Error(
        `the deployed ref (${source.kind === 'source' ? source.repoRef : ''}) predates the full-hub deploy — its apps/hub/docker-compose.yml ignores AGENTBOX_HUB_DATA_DIR, so this CLI's env and persistent-state wiring do not apply to it. Deploy a ref matching this CLI (omit --ref) or upgrade the CLI to match the ref.`,
      );
    }
  }
  const appPort = hubContainerPort(compose) ?? HUB_CONTAINER_PORT;
  log(`hub listens on :${String(appPort)} in-container (from the deployed compose)`);

  // The full-hub compose keys the deploy adds on top of the App/auth env:
  //  - the persistent data dir (bind-mounted at /root/.agentbox),
  //  - the public URL a hub-created box registers against (control-plane topology),
  //  - the admin PC egress CIDR (== this deploying machine) added to a hetzner
  //    box's firewall so the PC can still SSH direct (phase 4).
  const hubEnvExtra =
    `AGENTBOX_HUB_DATA_DIR=${REMOTE_DATA_DIR}\n` +
    `AGENTBOX_HUB_PUBLIC_URL=${url}\n` +
    `AGENTBOX_HUB_ADMIN_CIDR=${hostCidr}\n` +
    // Package mode only: the npm spec docker-compose.package.yml passes to the
    // image build as a build-arg (`${AGENTBOX_SPEC:?}`).
    (source.kind === 'package' ? `AGENTBOX_SPEC=${source.spec}\n` : '');
  const providerSecrets = await collectProviderSecrets();
  if (!providerSecrets) {
    log('warning: no provider credentials found in ~/.agentbox/secrets.env — the worker can only create boxes for providers whose creds you push later');
  }
  // The hub's own git credential travels with the provider secrets, not in the
  // compose env — see `splitHubGitToken`.
  const { env: composeEnv, token: hubGitToken } = splitHubGitToken(opts.envContent);
  const dataSecrets = hubGitToken ? `${providerSecrets}GH_TOKEN=${hubGitToken}\n` : providerSecrets;
  log(
    hubGitToken
      ? 'git auth: shipping the hub GitHub token to the VPS data volume (hub.gitAuth=gh)'
      : 'git auth: no GitHub token in the deploy env — the hub will need a GitHub App (hub.gitAuth=app)',
  );

  // Stage the secret env + Caddy config locally, then scp them up.
  const staging = join(tmpdir(), `agentbox-cp-deploy-${stamp}`);
  await mkdir(staging, { recursive: true });
  try {
    const envLocal = join(staging, 'control-plane.env');
    const caddyLocal = join(staging, 'Caddyfile');
    const composeLocal = join(staging, 'docker-compose.caddy.yml');
    const secretsLocal = join(staging, 'secrets.env');
    await writeFile(envLocal, composeEnv + hubEnvExtra, { mode: 0o600 });
    await writeFile(caddyLocal, caddyfile(domain, appPort));
    await writeFile(composeLocal, CADDY_COMPOSE);
    await writeFile(secretsLocal, dataSecrets, { mode: 0o600 });
    log('creating the persistent data dir on the VPS…');
    await sshExec(target, `mkdir -p ${REMOTE_DATA_DIR} && chmod 700 ${REMOTE_DATA_DIR}`);
    log('uploading env + provider secrets + Caddy config…');
    await scpUpload(target, envLocal, `${REMOTE_APP_DIR}/.env`);
    await scpUpload(target, caddyLocal, `${REMOTE_APP_DIR}/Caddyfile`);
    await scpUpload(target, composeLocal, `${REMOTE_APP_DIR}/docker-compose.caddy.yml`);
    if (deployAssets) {
      // No repo on the VPS in package mode — the whole compose stack travels.
      log('uploading the hub compose stack (package mode)…');
      for (const [name, localPath] of Object.entries(deployAssets)) {
        await scpUpload(target, localPath, `${REMOTE_APP_DIR}/${name}`);
      }
    }
    // Provider creds live in the data volume (read as ~/.agentbox/secrets.env),
    // NOT in the compose env — so they're never in `docker inspect`/compose logs.
    await scpUpload(target, secretsLocal, `${REMOTE_DATA_DIR}/secrets.env`);

    // Migrate the handful of config keys the control box needs (see
    // MIGRATED_CONFIG_KEYS). Read-modify-write against the VPS's existing file:
    // the hub writes this same config itself, so generating a fresh one would
    // drop its keys on every redeploy.
    const migrated = await collectMigratedConfig();
    if (Object.keys(migrated).length > 0) {
      const remoteCfg = await sshExec(
        target,
        `cat ${REMOTE_DATA_DIR}/config.yaml 2>/dev/null || true`,
      );
      const merged = buildControlPlaneConfigYaml(
        remoteCfg.exitCode === 0 ? remoteCfg.stdout : '',
        migrated,
      );
      if (merged) {
        const cfgLocal = join(staging, 'config.yaml');
        await writeFile(cfgLocal, merged, { mode: 0o600 });
        log(`migrating config to the control box: ${Object.keys(migrated).join(', ')}`);
        await scpUpload(target, cfgLocal, `${REMOTE_DATA_DIR}/config.yaml`);
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  log(
    source.kind === 'package'
      ? 'installing + starting the control plane (docker compose up --build)…'
      : 'building + starting the control plane (docker compose up --build)…',
  );
  const up = await sshExec(
    target,
    `cd ${REMOTE_APP_DIR} && docker compose ${composeFileArgs(source)} up -d --build`,
    { timeoutMs: 25 * 60_000, onLine: log },
  );
  if (up.exitCode !== 0) {
    throw new Error(`docker compose up failed (exit ${String(up.exitCode)}): ${up.stderr || up.stdout}`);
  }

  log(`waiting for HTTPS at ${url} …`);
  await pollHealthz(url, 3 * 60_000, log, () => diagnoseUnhealthy(target, appPort, source, domain));
  await assertAppStable(target, source, log);
}

/**
 * A single healthz 200 is not proof the hub stayed up.
 *
 * The hub starts listening BEFORE it starts its create worker, so a build that
 * boots and then throws (an older hub against a `gh`-mode env, say) serves
 * healthz for a moment and then dies — `restart: unless-stopped` retries, and the
 * poll can land in one of those windows. Seen live: an update reported "healthy"
 * while the container was crash-looping every 60s.
 *
 * `docker compose ps` is the ground truth: a crash-looping container reports
 * `restarting`, never `running`.
 */
/**
 * The `app` service's state out of `docker compose ps --format '{{.Service}}={{.State}}'`.
 * Undefined when the line isn't there at all — an unparseable `ps` must not fail
 * a hub that is answering, so the caller treats undefined as "assume fine".
 * Pure — unit-testable.
 */
export function appServiceState(psOutput: string): string | undefined {
  return /(?:^|\n)\s*app=(\S+)/.exec(psOutput)?.[1];
}

async function assertAppStable(
  target: SshTargetArgs,
  source: HubDeploySource,
  log: (line: string) => void,
): Promise<void> {
  const files = composeFileArgs(source);
  const ps = await sshExec(
    target,
    `cd ${REMOTE_APP_DIR} && docker compose ${files} ps --format '{{.Service}}={{.State}}'`,
  );
  const state = appServiceState(ps.stdout);
  if (state === undefined || state === 'running') return;
  log(`app container is "${state}" — collecting its logs…`);
  const logs = await sshExec(
    target,
    `cd ${REMOTE_APP_DIR} && docker compose ${files} logs --tail=25 app 2>&1`,
  );
  throw new Error(
    `the hub answered once but its container is "${state}", not running — it is crash-looping, ` +
      `so the version you deployed cannot stay up with this configuration.\n` +
      `--- app logs (last 25) ---\n${logs.stdout.trim()}`,
  );
}

export async function deployControlPlaneToHetzner(
  opts: ControlPlaneHetznerDeployOptions,
): Promise<ControlPlaneHetznerDeployResult> {
  const log = opts.onLog ?? (() => {});
  const source = opts.source;
  const client = makeHetznerClient();

  // Package mode ships the compose stack from the host, so resolve it BEFORE
  // spending money on a VPS — a partial dev build should fail here, not after.
  // (applyControlPlaneConfig resolves it again for real; this is the early gate.)
  if (source.kind === 'package') resolveHubDeployAssets();

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

  log(
    source.kind === 'package'
      ? `provisioning ${opts.serverType ?? 'cx23'} VPS (hub from npm: @madarco/agentbox@${source.spec})…`
      : `provisioning ${opts.serverType ?? 'cx23'} VPS (hub from source: ${source.repoUrl}@${source.repoRef})…`,
  );
  const { server } = await withHetznerRetry(
    { method: 'createServer', retryOnAmbiguous: false, attemptTimeoutMs: 120_000 },
    () =>
      client.createServer({
        name,
        server_type: opts.serverType ?? 'cx23',
        image: opts.serverImage ?? 'ubuntu-24.04',
        location: opts.location ?? 'nbg1',
        user_data: controlPlaneCloudInit({
          sshPubkey: key.publicKey,
          // Package mode needs no repo on the VPS at all.
          ...(source.kind === 'source' ? { repo: { url: source.repoUrl, ref: source.repoRef } } : {}),
        }),
        firewalls: [{ firewall: firewall.id }],
        labels: { 'agentbox.managed': 'true', 'agentbox.role': 'control-plane' },
        start_after_create: true,
      }),
  );

  const ip = await serverIpv4(client, server, 60_000);
  const domain = opts.domain ?? `${ip}.sslip.io`;
  const url = `https://${domain}`;
  const target: SshTargetArgs = { host: ip, user: 'root', identity: key.privatePath, knownHosts };

  const provisioned: ControlPlaneHetznerDeployResult = {
    url,
    serverId: server.id,
    ip,
    domain,
    firewallId: firewall.id,
    sshKeyDir: keyDir,
  };
  // Best-effort: a caller's bookkeeping failure must not abort a deploy that is
  // otherwise fine (the record is a debugging aid, not part of the contract).
  try {
    await opts.onProvisioned?.(provisioned);
  } catch {
    /* best-effort */
  }

  log(`VPS ${ip} up; waiting for ssh…`);
  if (!(await waitForSsh(target, 5 * 60_000))) {
    throw new Error(`ssh never came up on ${ip}`);
  }
  log(
    source.kind === 'package'
      ? 'waiting for cloud-init (Docker)…'
      : 'waiting for cloud-init (Docker + repo clone)…',
  );
  await sshExec(target, 'cloud-init status --wait || true', { timeoutMs: 12 * 60_000, onLine: log });

  await applyControlPlaneConfig({
    target,
    source,
    envContent: opts.envContent,
    url,
    domain,
    hostCidr,
    stamp,
    onLog: log,
    requireClonedRepo: true,
  });

  return provisioned;
}

export interface ControlPlaneUpdateOptions {
  /** The existing control box, from `deploy.json`. */
  record: { ip: string; sshKeyDir: string; url: string; domain?: string; firewallId?: number };
  /** The version to move to. */
  source: HubDeploySource;
  /** Contents of `control-plane.env`. */
  envContent: string;
  onLog?: (line: string) => void;
}

/**
 * Move an existing control box to a different build, in place.
 *
 * Everything after the ssh hop is the same code a fresh deploy runs
 * (`applyControlPlaneConfig`), which is deliberate: a newer hub can want `.env`
 * keys, a different container port, or new compose assets, and re-running the
 * whole configuration is the only way an update stays equivalent to a redeploy.
 * The hub self-migrates its auth + store on boot, so there is no migrate step.
 *
 * The data volume (`/opt/agentbox/hub-data`) is never touched, so the store,
 * logins, custody and box SSH keys survive.
 */
export async function updateControlPlaneOnHetzner(
  opts: ControlPlaneUpdateOptions,
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const { record, source } = opts;
  const stamp = Date.now().toString(36);
  const domain = record.domain ?? new URL(record.url).hostname;

  // Only :22 is locked to an IP (:80/:443 stay open so boxes can reach the hub),
  // so a laptop that changed networks since the deploy cannot ssh in at all.
  // Re-sync over the Hetzner API FIRST — that path still works when ssh doesn't,
  // which is exactly the situation that needs fixing.
  const hostCidr = normalizeSourceCidr(await detectEgressIp());
  if (record.firewallId !== undefined) {
    const client = makeHetznerClient();
    const fw = await client.getFirewall(record.firewallId);
    const sshRule = fw?.rules.find((r) => r.direction === 'in' && r.port === '22');
    if (fw && firewallNeedsSync(sshRule?.source_ips, hostCidr)) {
      log(`egress IP changed — re-locking SSH to ${hostCidr}…`);
      await client.setFirewallRules(record.firewallId, controlPlaneInboundRules(hostCidr));
    }
  }

  const target: SshTargetArgs = {
    host: record.ip,
    user: 'root',
    identity: join(record.sshKeyDir, 'id_ed25519'),
    knownHosts: join(record.sshKeyDir, 'known_hosts'),
  };
  log(`connecting to ${record.ip}…`);
  if (!(await waitForSsh(target, 2 * 60_000))) {
    throw new Error(
      `ssh did not come up on ${record.ip} — the VPS may be off, or its firewall still allows a different IP than ${hostCidr}`,
    );
  }

  if (source.kind === 'source') {
    // A package-mode box has no repo at all — cloud-init skipped the clone — so
    // `git fetch` there would fail with a bare "not a git repository". Say what
    // is actually wrong instead.
    const isRepo = await sshExec(target, `test -d ${REMOTE_REPO_DIR}/.git`);
    if (isRepo.exitCode !== 0) {
      throw new Error(
        `this control box was installed from npm, so there is no git checkout on it to update. ` +
          `\`hub update --ref\` only works on a box deployed with --ref; to switch, deploy a new one ` +
          `(\`agentbox hub deploy hetzner --ref ${source.repoRef}\`) and destroy this one.`,
      );
    }
    // Fetch by ref then check out FETCH_HEAD, so a branch, a tag and a bare sha
    // all work through one path (the same reason cloud-init's clone is two-step).
    log(`checking out ${source.repoRef} on the VPS…`);
    const co = await sshExec(
      target,
      `cd ${REMOTE_REPO_DIR} && git remote set-url origin ${shQuote(source.repoUrl)} && git fetch --depth 1 origin ${shQuote(source.repoRef)} && git checkout --force FETCH_HEAD`,
      { timeoutMs: 5 * 60_000, onLine: log },
    );
    if (co.exitCode !== 0) {
      throw new Error(
        `could not check out ${source.repoRef} on the VPS (exit ${String(co.exitCode)}): ${co.stderr || co.stdout}`,
      );
    }
  }

  await applyControlPlaneConfig({
    target,
    source,
    envContent: opts.envContent,
    url: record.url,
    domain,
    hostCidr,
    stamp,
    onLog: log,
  });
}

export interface ControlPlaneDestroyResult {
  serverDeleted: boolean;
  firewallDeleted: boolean;
  /** Non-fatal problems worth reporting (already-gone resources, API errors). */
  warnings: string[];
}

/**
 * Delete a control box's Hetzner resources. Needs no ssh — which matters,
 * because `:22` is locked to whichever egress IP deployed the box, so a user on
 * a different network can still tear it down.
 *
 * Never throws for a resource that is already gone: the local state must still
 * be purged afterwards, or a half-deleted control box leaves the user with
 * config pointing at nothing and no command that will clear it.
 */
export async function destroyControlPlaneOnHetzner(opts: {
  serverId?: number;
  firewallId?: number;
  onLog?: (line: string) => void;
  /** Seam for tests; defaults to the real Hetzner client. */
  client?: Pick<HetznerClient, 'deleteServer' | 'deleteFirewall'>;
  /** Seam for tests; the wait between firewall-delete attempts. */
  retryDelayMs?: number;
}): Promise<ControlPlaneDestroyResult> {
  const log = opts.onLog ?? (() => {});
  const client = opts.client ?? makeHetznerClient();
  const retryDelayMs = opts.retryDelayMs ?? 5_000;
  const warnings: string[] = [];
  let serverDeleted = false;
  let firewallDeleted = false;

  if (opts.serverId !== undefined) {
    try {
      log(`deleting server ${String(opts.serverId)}…`);
      await client.deleteServer(opts.serverId);
      serverDeleted = true;
    } catch (e) {
      warnings.push(`server ${String(opts.serverId)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (opts.firewallId !== undefined) {
    // Hetzner refuses to delete a firewall still applied to a server, and the
    // delete above is asynchronous, so give the detach a few seconds to land.
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        log(`deleting firewall ${String(opts.firewallId)}…`);
        await client.deleteFirewall(opts.firewallId);
        firewallDeleted = true;
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt === 5) {
          warnings.push(`firewall ${String(opts.firewallId)}: ${msg}`);
          break;
        }
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }

  return { serverDeleted, firewallDeleted, warnings };
}
