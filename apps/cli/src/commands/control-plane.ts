import { confirm, isCancel, log, note, select, spinner } from '@clack/prompts';
import { Command, Option } from 'commander';
import { spawn } from 'node:child_process';
import { execa } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  findProjectRoot,
  loadEffectiveConfig,
  setConfigValue,
  unsetConfigValue,
  type HubGitAuthMode,
} from '@agentbox/config';
import {
  DEFAULT_ENV_PATTERNS,
  projectSlugFromOriginUrl,
  readPreparedStateRaw,
} from '@agentbox/sandbox-core';
import {
  applyProjectSeed,
  deadlineFetch,
  hostReachable,
  pushPreparedToCustody,
  pushProjectSeedToCustody,
  readGitOriginUrl,
} from '@agentbox/sandbox-cloud';

/** Bound on the worker's seed download once the control box is known to be up. */
const SEED_FETCH_MS = 120_000;
import {
  drainCreateJobs,
  GitHubAppLeaser,
  loadGitHubAppConfig,
  parseGitRemote,
  PostgresStore,
  toAuthedHttpsUrl,
} from '@agentbox/relay';
import { randomBytes } from 'node:crypto';
import { providerForCreate } from '../provider/registry.js';
import { getRuntimeProviderNames, loadProviderModule } from '../provider/loaders.js';
import {
  buildRebakeNote,
  buildShareFailedNote,
  classifyBakeShare,
  hasCredentialChanges,
  isShareablePreparedProvider,
  summarizeBakeShare,
  type BakeShareResult,
} from '../control-plane/bake-share.js';
import { makeControlPlaneCreateBox, cloneRepoWithLfs } from '../control-plane/create-box.js';
import { runGitHubAppManifestFlow } from '../control-plane/github-app-manifest.js';
import { deployControlPlaneToVercel } from '../control-plane/deploy-vercel.js';
import {
  assertReachableRecord,
  purgeLocalControlPlaneState,
  readDeployRecord,
  recoveryHint,
  runHetznerDeploy,
  runHetznerDestroy,
  runHetznerUpdate,
} from '../control-plane/deploy-hetzner.js';
import {
  recoveryHint as recoveryHintDigitalOcean,
  runDigitalOceanDeploy,
  runDigitalOceanDestroy,
  runDigitalOceanUpdate,
} from '../control-plane/deploy-digitalocean.js';
import { fetchNpmBest } from '../lib/update-check.js';
import {
  runExpose,
  runLocalUpdate,
  runLocalDestroy,
  type ExposeResult,
} from '../control-plane/expose.js';
import type { TunnelKind } from '../control-plane/tunnel.js';
import {
  defaultDeployRef,
  describeHubDeploySource,
  resolveHubDeploySource,
} from '../control-plane/deploy-ref.js';
import { AGENTBOX_VERSION } from '../version.js';
import {
  findHostGitToken,
  overbroadScopes,
  resolveTokenLogin,
  resolveTokenScopes,
} from '../control-plane/host-git-token.js';
import { openCommandLog } from '../lib/log-file.js';
import { AGENTBOX_HUB_SSH_ALIAS, type ControlPlaneDeployRecord } from '@agentbox/sandbox-core';
import { resolveHubAuthEnv } from '../control-plane/hub-auth-env.js';
import {
  addRepoUrl,
  checkRepoInstalled,
  loadControlPlaneMeta,
  openInBrowser,
  resolveOwnerRepo,
} from '../control-plane/ensure-repo-installed.js';
import {
  CustodyClient,
  collectAgentCredentialUploads,
  planPush,
  type UploadItem,
} from '../control-plane/custody-client.js';
import {
  HubApiClient,
  HubApiError,
  type HubLifecycleAction,
} from '../control-plane/hub-api-client.js';
import { hubApiTargetFrom, withHubClient } from '../control-plane/with-hub.js';
import { loadControlPlaneEnv } from '../control-plane/env-file.js';
import { getHubJob, listHubJobs } from '../control-plane/hub-enqueue.js';
import type { CreateJobRow } from '@agentbox/relay/control-plane';
import { AGENT_SYNC_SPECS } from '@agentbox/sandbox-core';
import { handleLifecycleError } from './_errors.js';

const CP_DIR = join(homedir(), '.agentbox', 'control-plane');
const PEM_PATH = join(CP_DIR, 'github-app.pem');
const ENV_PATH = join(CP_DIR, 'control-plane.env');
const META_PATH = join(CP_DIR, 'control-plane.json');

/** Default GitHub repo the control plane is deployed from (Vercel + Hetzner). */
const DEFAULT_DEPLOY_REPO = 'madarco/agentbox';
/** `--repo` accepts an `owner/name` slug or a full git URL; the VPS clones a URL. */
function repoSlugToUrl(spec: string): string {
  return spec.includes('://') ? spec : `https://github.com/${spec}.git`;
}
/** Tracks the running CLI — see `deployRefForVersion` for why it can't be a constant. */
const DEFAULT_DEPLOY_REF = defaultDeployRef();

/** Persist `relay.controlPlaneUrl` and report it. Shared by set-url + setup. */
async function applyControlPlaneUrl(url: string): Promise<string> {
  const trimmed = url.replace(/\/$/, '');
  await setConfigValue('global', 'relay.controlPlaneUrl', trimmed, process.cwd());
  return trimmed;
}

/** Poll a deployed plane's /healthz until it answers (or the deadline elapses). */
async function waitForHealthz(url: string, deadlineMs: number): Promise<boolean> {
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await delay(4000);
  }
  return false;
}

/**
 * The hetzner hub-auth env block appended to `control-plane.env`. The full-hub
 * compose sets the profile literally, but these secrets (`BETTER_AUTH_SECRET`,
 * admin email/password) are read from the `.env` by the compose file, so a
 * network-reachable hub is login-gated.
 */
function hetznerAuthBody(hubAuth: {
  AGENTBOX_HUB_AUTH: string;
  BETTER_AUTH_SECRET: string;
  AGENTBOX_HUB_ADMIN_EMAIL: string;
  AGENTBOX_HUB_ADMIN_PASSWORD: string;
}): string {
  return (
    `AGENTBOX_HUB_PROFILE=hetzner\n` +
    `AGENTBOX_HUB_AUTH=${hubAuth.AGENTBOX_HUB_AUTH}\n` +
    `BETTER_AUTH_SECRET=${hubAuth.BETTER_AUTH_SECRET}\n` +
    `AGENTBOX_HUB_ADMIN_EMAIL=${hubAuth.AGENTBOX_HUB_ADMIN_EMAIL}\n` +
    `AGENTBOX_HUB_ADMIN_PASSWORD=${hubAuth.AGENTBOX_HUB_ADMIN_PASSWORD}\n`
  );
}

/**
 * Ensure `control-plane.env` carries the hub-auth block (a prior `setup --deploy
 * none` writes only the App creds). Appends it when `BETTER_AUTH_SECRET` is
 * absent; returns false only if the operator cancels the login prompt.
 */
async function ensureHetznerHubAuth(): Promise<boolean> {
  const body = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  if (/^BETTER_AUTH_SECRET=/m.test(body)) return true;
  const hubAuth = await resolveHubAuthEnv();
  if (!hubAuth) return false;
  await writeFile(ENV_PATH, body + hetznerAuthBody(hubAuth), { mode: 0o600 });
  await chmod(ENV_PATH, 0o600);
  return true;
}

/**
 * The auth block for a LOCAL exposed hub: just the login secret + admin creds.
 * Unlike {@link hetznerAuthBody} it omits `AGENTBOX_HUB_PROFILE`/`AGENTBOX_HUB_AUTH`
 * — those are set on the spawn env by `buildExposedHubEnv`, not read from the
 * file (and leaving the profile out of the file keeps it from bleeding into the
 * CLI's own `process.env` via `loadControlPlaneEnv`).
 */
function localHubAuthBody(hubAuth: {
  BETTER_AUTH_SECRET: string;
  AGENTBOX_HUB_ADMIN_EMAIL: string;
  AGENTBOX_HUB_ADMIN_PASSWORD: string;
}): string {
  return (
    `BETTER_AUTH_SECRET=${hubAuth.BETTER_AUTH_SECRET}\n` +
    `AGENTBOX_HUB_ADMIN_EMAIL=${hubAuth.AGENTBOX_HUB_ADMIN_EMAIL}\n` +
    `AGENTBOX_HUB_ADMIN_PASSWORD=${hubAuth.AGENTBOX_HUB_ADMIN_PASSWORD}\n`
  );
}

/** Ensure the local exposed hub's login secret + admin creds are in the env file. */
async function ensureLocalHubAuth(): Promise<boolean> {
  const body = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  if (/^BETTER_AUTH_SECRET=/m.test(body)) return true;
  const hubAuth = await resolveHubAuthEnv();
  if (!hubAuth) return false;
  await writeFile(ENV_PATH, body + localHubAuthBody(hubAuth), { mode: 0o600 });
  await chmod(ENV_PATH, 0o600);
  return true;
}

type DeployTarget = 'vercel' | 'hetzner' | 'digitalocean' | 'local' | 'none';

interface SetupOpts {
  gitAuth?: string;
  name?: string;
  org?: string;
  deploy?: string;
  ref?: string;
  repo?: string;
  package?: string;
  // --deploy local passthrough (see `hub expose`).
  bind?: string;
  tunnel?: string;
  tunnelToken?: string;
  publicUrl?: string;
  autostart?: boolean;
}

/**
 * `gh` is mandatory for the remote hub: the control box leases the push tokens
 * its cloud boxes use through the GitHub CLI. Given the resolved path (or null
 * when it isn't on PATH), returns the error to print, else null. Pure over the
 * lookup so the message is unit-testable without spawning anything.
 */
export function ghPreflightError(ghPath: string | null): string | null {
  if (ghPath) return null;
  return (
    'The GitHub CLI (`gh`) is required to set up a remote Hub — the control box leases push tokens through it.\n' +
    'Install it from https://cli.github.com, run `gh auth login`, then re-run `agentbox hub setup`.'
  );
}

/** Resolve `bin` on PATH (definitive install check), or null when absent. */
async function onPath(bin: string): Promise<string | null> {
  const r = await execa('which', [bin], { reject: false });
  if (r.exitCode !== 0) return null;
  const p = (r.stdout ?? '').trim();
  return p.length > 0 ? p : null;
}

/** The flag, else the config default (`gh`). An unknown value is a hard error. */
async function resolveGitAuthMode(flag: string | undefined): Promise<HubGitAuthMode> {
  if (flag === 'gh' || flag === 'app') return flag;
  if (flag) throw new Error(`unknown --git-auth "${flag}" (expected: gh | app)`);
  const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
  return cfg?.effective.hub.gitAuth ?? 'gh';
}

/**
 * Find (and confirm) the GitHub token the control box will use as its own.
 *
 * Shown before it leaves the machine — this is a credential being copied to a
 * server, so "which token, whose account, what can it do" has to be visible
 * rather than inferred. Returns null when the user declines or none is found.
 */
async function resolveHubGitToken(logLine: (line: string) => void): Promise<string | null> {
  const s = spinner();
  s.start('looking for a GitHub token on this machine');
  const found = await findHostGitToken();
  if (!found) {
    s.stop('no GitHub token found', 1);
    log.error(
      'No GitHub credential found on this machine.\n' +
        'Run `gh auth login` (browser flow, no admin approval needed) and try again.',
    );
    return null;
  }
  const [login, scopes] = await Promise.all([
    resolveTokenLogin(found.token),
    resolveTokenScopes(found.token),
  ]);
  s.stop(
    `found a GitHub token via ${found.source === 'gh' ? '`gh auth token`' : "git's credential helper"}` +
      (login ? ` (@${login})` : ''),
  );
  logLine(
    `git token source=${found.source} login=${login ?? '?'} scopes=${scopes.join(',') || '(none reported)'}`,
  );

  const wide = overbroadScopes(scopes);
  const detail = [
    `The control box will hold this token and use it to clone and push on your boxes' behalf.`,
    `Boxes never receive it.`,
    login ? `Account: @${login}` : null,
    scopes.length > 0 ? `Scopes: ${scopes.join(', ')}` : null,
    wide.length > 0
      ? `Warning: this token carries ${wide.join(', ')} — far more than the hub needs (contents + pull requests). Consider a fine-grained token scoped to the repos you'll use.`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
  note(detail, 'Git credential');

  const ok = await confirm({ message: 'Copy this token to the control box?' });
  if (isCancel(ok) || !ok) {
    log.warn('cancelled — no token copied.');
    return null;
  }
  return found.token;
}

const setupSub = new Command('setup')
  .description('Set up a persistent remote Hub for your AgentBoxes')
  // The GitHub-App path is no longer surfaced (we want a plain `gh` token) but
  // still works when passed explicitly, so these three options are hidden, not
  // removed. gh is the default, so nobody needs `--git-auth` for the normal path.
  .addOption(
    new Option(
      '--git-auth <mode>',
      'how the control box reaches GitHub (default: reuse your own gh token)',
    ).hideHelp(),
  )
  .addOption(new Option('--name <name>', 'GitHub App name').hideHelp())
  .addOption(new Option('--org <org>', 'create the App under an organization').hideHelp())
  .option(
    '--deploy <target>',
    'what to do after writing the config: hetzner | digitalocean | vercel | local (expose this machine) | none',
  )
  .option(
    '--repo <owner/name>',
    "GitHub repo to deploy the plane from (default madarco/agentbox; fork + pass this if you don't own it). Implies building from source",
  )
  .option(
    '--ref <ref>',
    `build the hub from source at this git ref instead of installing the published package (branch/tag/sha; ${DEFAULT_DEPLOY_REF} matches this CLI)`,
  )
  .option(
    '--package <spec>',
    `npm spec of @madarco/agentbox to install on the control box (default ${AGENTBOX_VERSION}, this CLI's own version)`,
  )
  .option(
    '--bind <addr>',
    '--deploy local: hub bind address (default 0.0.0.0 for LAN; 127.0.0.1 = loopback + tunnel only)',
  )
  .option(
    '--tunnel <kind>',
    '--deploy local: make cloud boxes able to reach the hub: cloudflare | tailscale',
  )
  .option(
    '--tunnel-token <token>',
    '--deploy local: named Cloudflare tunnel token (stable hostname)',
  )
  .option(
    '--public-url <url>',
    '--deploy local: the box-facing URL (your own proxy/DNS); skips tunnel URL scraping',
  )
  .option('--no-autostart', '--deploy local: do not install a launchd/systemd autostart unit')
  .action(async (opts: SetupOpts) => {
    // Every progress line here goes to a @clack spinner, which overwrites
    // itself — a failed deploy left nothing to read afterwards. Tee to
    // ~/.agentbox/logs/hub-setup.log (and latest.log) like create/claude do.
    const cmdLog = openCommandLog('hub-setup');
    try {
      // gh is mandatory for the remote hub — fail fast before any App/deploy work.
      const ghErr = ghPreflightError(await onPath('gh'));
      if (ghErr) {
        log.error(ghErr);
        cmdLog.write(`preflight: ${ghErr.replace(/\n/g, ' ')}`);
        process.exitCode = 1;
        return;
      }
      const gitAuth = await resolveGitAuthMode(opts.gitAuth);
      cmdLog.write(`git auth mode: ${gitAuth}`);

      // The App path is now opt-in: it needs the repo OWNER to install the App,
      // which in most work orgs is an admin decision the user can't make.
      let app: Awaited<ReturnType<typeof runGitHubAppManifestFlow>> | null = null;
      let hostToken: string | null = null;
      if (gitAuth === 'app') {
        // Globally-unique by default — GitHub rejects duplicate App names.
        const name = opts.name ?? `agentbox-${randomBytes(4).toString('hex')}`;
        note(
          'Your browser will open to GitHub to create the App. Review the\n' +
            'permissions (Contents + Pull requests: write) and click "Create".',
          'GitHub App',
        );
        const s = spinner();
        s.start('waiting for the GitHub App to be created in your browser');
        app = await runGitHubAppManifestFlow({
          appName: String(name),
          org: opts.org,
          // Honor GHES overrides (and make the flow scriptable in tests).
          githubUrl: process.env.GITHUB_URL,
          apiBaseUrl: process.env.GITHUB_API_URL,
          openBrowser: openInBrowser,
          log: (line) => {
            s.message(line);
            cmdLog.write(line);
          },
        });
        s.stop(`GitHub App created: ${app.slug} (id ${app.appId})`);
        cmdLog.write(`GitHub App created: ${app.slug} (id ${app.appId})`);
      } else {
        hostToken = await resolveHubGitToken(cmdLog.write.bind(cmdLog));
        if (!hostToken) {
          process.exitCode = 1;
          return;
        }
      }

      // Persist the credential + a generated admin token as the plane's deploy env.
      const adminToken = randomBytes(32).toString('hex');
      // Headless bearer for the hub's public /api/v1 (CLI / tray against a remote
      // control box, which can't carry the browser session cookie). Separate from
      // the admin token, which gates the internal /admin/* wire.
      const hubApiKey = randomBytes(32).toString('hex');
      await mkdir(CP_DIR, { recursive: true });
      let credentialLines = '';
      if (app) {
        await writeFile(PEM_PATH, app.pem, { mode: 0o600 });
        await chmod(PEM_PATH, 0o600);
        credentialLines =
          `GITHUB_APP_ID=${app.appId}\n` +
          `GITHUB_APP_PRIVATE_KEY=${Buffer.from(app.pem, 'utf8').toString('base64')}\n`;
      } else if (hostToken) {
        // Routed to the VPS's data-volume secrets.env by the deploy, never into
        // the compose `environment:` block (readable via `docker inspect`).
        credentialLines = `GH_TOKEN=${hostToken}\n`;
      }
      const envBody =
        `# AgentBox control plane deploy env (generated by 'agentbox hub setup').\n` +
        `# Feed to docker compose (--env-file) or 'vercel env add'. Keep secret.\n` +
        credentialLines +
        `AGENTBOX_RELAY_ADMIN_TOKEN=${adminToken}\n` +
        `AGENTBOX_HUB_API_KEY=${hubApiKey}\n`;
      await writeFile(ENV_PATH, envBody, { mode: 0o600 });
      await chmod(ENV_PATH, 0o600);
      if (app) {
        await writeFile(
          META_PATH,
          JSON.stringify(
            { appId: app.appId, slug: app.slug, htmlUrl: app.htmlUrl, installUrl: app.installUrl },
            null,
            2,
          ) + '\n',
          { mode: 0o600 },
        );
      }

      log.success(
        app
          ? `GitHub App ready. Deploy config written to ${ENV_PATH} (0600).`
          : `Git credential ready. Deploy config written to ${ENV_PATH} (0600).`,
      );

      // --- Deploy step (after the App exists) ---
      const target = await resolveDeployTarget(opts.deploy);

      // Local: flip THIS machine's hub into the control box — no VPS. Own path
      // (no remote deploy spinner / healthz-over-the-internet), then return.
      if (target === 'local') {
        if (!(await ensureLocalHubAuth())) {
          log.warn('cancelled — no admin login set; the exposed hub would be open. Not exposing.');
          return;
        }
        const exposed = await runLocalExpose(opts, cmdLog.write.bind(cmdLog));
        // This machine is now the control box (reached over loopback) — get its
        // agent logins + bake records in place before the first hub-created box.
        if (exposed) await finalizeControlBoxState(undefined);
        return;
      }

      let deployedUrl: string | null = null;
      if (target !== 'none') {
        // Prompt for the hub login admin BEFORE the deploy spinner starts (a
        // spinner and @clack prompts can't share the terminal). Setting these
        // turns login on in the deployed hub so it is never left loginless — both
        // vercel and hetzner (the Caddy-HTTPS docker-compose deploy).
        const hubAuth = await resolveHubAuthEnv();
        // hetzner + digitalocean read ENV_PATH (written to the VPS .env) — the
        // same docker-compose deploy — so append the auth env + the profile so
        // docker-compose enforces login there too.
        if ((target === 'hetzner' || target === 'digitalocean') && hubAuth) {
          await writeFile(ENV_PATH, envBody + hetznerAuthBody(hubAuth), { mode: 0o600 });
          await chmod(ENV_PATH, 0o600);
        }
        const ds = spinner();
        ds.start(`deploying the control plane to ${target}`);
        // Captured from the deploy's onProvisioned so a later failure can still
        // tell the user how to reach the (still-running) VPS.
        let provisioned: ControlPlaneDeployRecord | null = null;
        try {
          const onLog = (line: string): void => {
            ds.message(line);
            cmdLog.write(line);
          };
          const repo = opts.repo ?? DEFAULT_DEPLOY_REPO;
          const ref = opts.ref ?? DEFAULT_DEPLOY_REF;
          if (target === 'vercel') {
            // Vercel has no data volume, so the git token has to ride the
            // project env there (encrypted at rest) rather than a secrets file.
            const env = {
              ...(app
                ? {
                    GITHUB_APP_ID: app.appId,
                    GITHUB_APP_PRIVATE_KEY: Buffer.from(app.pem, 'utf8').toString('base64'),
                  }
                : {}),
              ...(hostToken ? { GH_TOKEN: hostToken } : {}),
              AGENTBOX_RELAY_ADMIN_TOKEN: adminToken,
              AGENTBOX_HUB_API_KEY: hubApiKey,
              ...(hubAuth ?? {}),
            };
            deployedUrl = (await deployControlPlaneToVercel({ env, repo, ref, log: onLog })).url;
          } else {
            const source = resolveHubDeploySource(AGENTBOX_VERSION, {
              ref: opts.ref,
              // `--repo` is an owner/name slug for Vercel; the VPS clones a URL.
              ...(opts.repo ? { repoUrl: repoSlugToUrl(opts.repo) } : {}),
              ...(opts.package ? { packageSpec: opts.package } : {}),
            });
            onLog(`hub source: ${describeHubDeploySource(source)}`);
            // hetzner + digitalocean share the same docker-compose VPS deploy,
            // signature-compatible; only the provisioned cloud differs.
            const runVpsDeploy =
              target === 'digitalocean' ? runDigitalOceanDeploy : runHetznerDeploy;
            deployedUrl = (
              await runVpsDeploy({
                envPath: ENV_PATH,
                source,
                log: onLog,
                onProvisioned: (info) => {
                  provisioned = info;
                },
              })
            ).url;
          }
          ds.stop(`deployed: ${deployedUrl}`);
        } catch (e) {
          // Stop the spinner (code 1) before printing — otherwise it keeps
          // animating its last "creating the firewall…" frame under the error.
          ds.stop(`deploy to ${target} failed`, 1);
          const msg = e instanceof Error ? e.message : String(e);
          cmdLog.write(`deploy to ${target} failed: ${msg}`);
          log.warn(`deploy to ${target} failed: ${msg}`);
          const hint = target === 'digitalocean' ? recoveryHintDigitalOcean : recoveryHint;
          if (provisioned) note(hint(provisioned).join('\n'), 'Debug the VPS');
          log.info(`Full deploy log: ${cmdLog.path}`);
          printManualDeploy();
        }
      } else {
        printManualDeploy();
      }

      if (deployedUrl) {
        const url = await applyControlPlaneUrl(deployedUrl);
        log.success(`Pointed the CLI at ${url} (relay.controlPlaneUrl).`);
        const ok = await waitForHealthz(url, 60_000);
        // Terse on success; the failure branch stays informative (names the URL).
        if (ok) log.success('Healthy');
        else log.warn(`Could not confirm ${url}/healthz yet — check the deployment.`);
        // Only once the box answers is there anything to push to.
        if (ok) await finalizeControlBoxState(url);
      }

      if (app) {
        // Open the repo-selection page so the user can authorize repos right away.
        log.info(`Install the App on your repos: ${app.installUrl}`);
        openInBrowser(app.installUrl);
      }
    } catch (err) {
      cmdLog.write(`FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      handleLifecycleError(err);
    } finally {
      cmdLog.close();
    }
  });

/**
 * The deploy targets offered in the interactive picker. Vercel is intentionally
 * absent — `--deploy vercel` still works when passed explicitly, it's just no
 * longer surfaced. Exported so the omission is unit-testable.
 */
export const INTERACTIVE_DEPLOY_OPTIONS: ReadonlyArray<{ value: DeployTarget; label: string }> = [
  { value: 'local', label: 'This machine — turn the local hub into the control box (no VPS)' },
  { value: 'hetzner', label: 'Hetzner VPS — HTTPS via <ip>.sslip.io + Caddy/Let’s Encrypt' },
  {
    value: 'digitalocean',
    label: 'DigitalOcean Droplet — HTTPS via <ip>.sslip.io + Caddy/Let’s Encrypt',
  },
  { value: 'none', label: 'Skip — I’ll deploy later (print manual steps)' },
];

/** Resolve the deploy target from the flag, or ask interactively. */
export async function resolveDeployTarget(flag: string | undefined): Promise<DeployTarget> {
  if (
    flag === 'vercel' ||
    flag === 'hetzner' ||
    flag === 'digitalocean' ||
    flag === 'local' ||
    flag === 'none'
  )
    return flag;
  if (flag) {
    log.warn(`unknown --deploy "${flag}"; choose interactively`);
  }
  const choice = await select({
    message: 'Deploy the control plane now?',
    options: [...INTERACTIVE_DEPLOY_OPTIONS],
    initialValue: 'local',
  });
  if (isCancel(choice)) return 'none';
  return choice as DeployTarget;
}

function printManualDeploy(): void {
  log.info(
    [
      'Deploy later with the written env:',
      `  This machine: agentbox hub expose            (no VPS — the local hub becomes the control box)`,
      `  Self-host:    cd apps/hub && docker compose --env-file ${ENV_PATH} up --build`,
      `  Vercel:       agentbox hub setup --deploy vercel  (or 'vercel env add' the vars + 'vercel deploy --prod')`,
      `  Then:         agentbox hub set-url https://<your-plane-url>`,
    ].join('\n'),
  );
}

interface ExposeCliOpts {
  bind?: string;
  tunnel?: string;
  tunnelToken?: string;
  publicUrl?: string;
  autostart?: boolean;
}

/**
 * Run the expose flow with a spinner, then report reachability + autostart.
 * Returns the {@link ExposeResult} on success, or null when the flow bailed (bad
 * flag / expose error) so the caller knows not to run the post-expose steps.
 */
async function runLocalExpose(
  opts: ExposeCliOpts,
  logWrite: (l: string) => void,
): Promise<ExposeResult | null> {
  const tunnel = opts.tunnel;
  if (tunnel && tunnel !== 'cloudflare' && tunnel !== 'tailscale') {
    log.error(`unknown --tunnel "${tunnel}" (expected: cloudflare | tailscale)`);
    process.exitCode = 1;
    return null;
  }
  const s = spinner();
  s.start('exposing the local hub as the control box');
  let result: ExposeResult;
  try {
    result = await runExpose({
      ...(opts.bind ? { bind: opts.bind } : {}),
      ...(tunnel ? { tunnel: tunnel as TunnelKind } : {}),
      ...(opts.tunnelToken ? { tunnelToken: opts.tunnelToken } : {}),
      ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
      autostart: opts.autostart !== false,
      onLog: (l) => {
        s.message(l);
        logWrite(l);
      },
    });
    s.stop(`hub exposed on ${result.publicUrl}`);
  } catch (e) {
    s.stop('expose failed', 1);
    const msg = e instanceof Error ? e.message : String(e);
    logWrite(`expose failed: ${msg}`);
    log.error(msg);
    process.exitCode = 1;
    return null;
  }
  note(
    [
      `Box-facing URL:  ${result.publicUrl}`,
      `CLI / UI (local): ${result.localUrl}`,
      result.record.tunnel ? `Tunnel:          ${result.record.tunnel}` : null,
      result.autostart?.path ? `Autostart:       ${result.autostart.path}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    'Control box',
  );
  if (!result.cloudReachable) {
    log.warn(
      'LAN/loopback only: cloud boxes (e2b/daytona/hetzner/vercel) cannot reach this hub, so they will ' +
        'not register or push with your machine off. Re-run with `--tunnel cloudflare` (or `--tunnel tailscale`) to enable that.',
    );
  }
  if (result.autostart?.note) log.info(result.autostart.note);
  log.success(
    `This machine is now the control box — sign in at ${result.localUrl}; cloud creates route here.`,
  );
  return result;
}

const exposeSub = new Command('expose')
  .description("Turn this machine's local hub into the control box (deployed profile, no VPS)")
  .option(
    '--bind <addr>',
    'bind address (default 0.0.0.0 for LAN; 127.0.0.1 = loopback + tunnel only)',
  )
  .option('--tunnel <kind>', 'let cloud boxes reach the hub: cloudflare | tailscale')
  .option('--tunnel-token <token>', 'named Cloudflare tunnel token (stable hostname)')
  .option(
    '--public-url <url>',
    'the box-facing URL (your own proxy/DNS); skips tunnel URL scraping',
  )
  .option('--no-autostart', 'do not install a launchd/systemd autostart unit')
  .action(async (opts: ExposeCliOpts) => {
    try {
      if (!existsSync(ENV_PATH)) {
        log.error(
          'No control-box credentials yet. Run `agentbox hub setup --deploy local` first — it mints the ' +
            'admin token + API key and the git credential, then exposes.',
        );
        process.exitCode = 1;
        return;
      }
      if (!(await ensureLocalHubAuth())) {
        log.warn('cancelled — an admin login is required so the exposed hub is not left open.');
        return;
      }
      const exposed = await runLocalExpose(opts, () => {});
      // Re-exposing is still "a control box just came up" — get its logins +
      // bake records in place, exactly as `hub setup --deploy local` does.
      if (exposed) await finalizeControlBoxState(undefined);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

/**
 * The loopback URL of a control box that IS this machine (`hub expose`), or null.
 * The CLI-facing local shortcut: when a hub is exposed here, `hub boxes`,
 * custody, and `hub target` talk to `127.0.0.1:<port>` rather than the
 * box-facing `relay.controlPlaneUrl` (which is the LAN/tunnel URL boxes use).
 */
export async function localExposedLoopbackUrl(): Promise<string | null> {
  const rec = await readDeployRecord();
  if (rec?.provider === 'local') return `http://127.0.0.1:${String(rec.port ?? 8787)}`;
  return null;
}

/** Prefer the loopback shortcut for a locally-exposed hub, unless `--url` is explicit. */
async function applyLocalShortcut(url: string, urlFlag: string | undefined): Promise<string> {
  if (urlFlag) return url;
  const loop = await localExposedLoopbackUrl();
  return loop ?? url;
}

const setUrlSub = new Command('set-url')
  .description('Point boxes + the CLI at a deployed control plane (sets relay.controlPlaneUrl)')
  .argument('<url>', 'base URL of the deployed control plane, e.g. https://plane.example.com')
  .action(async (url: string) => {
    try {
      const trimmed = await applyControlPlaneUrl(url);
      log.success(`Set relay.controlPlaneUrl = ${trimmed}`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const unsetUrlSub = new Command('unset-url')
  .description('Stop using a control plane on this machine (removes relay.controlPlaneUrl)')
  .option(
    '--purge',
    "also delete this machine's local App metadata + admin token (~/.agentbox/control-plane)",
  )
  .action(async (opts: { purge?: boolean }) => {
    try {
      // set-url writes the global scope; also clear a per-project override if one
      // exists. A cwd with no project config just yields `existed:false` (the
      // project unset never throws for that) — real I/O/write errors from either
      // scope propagate to handleLifecycleError rather than being masked.
      const g = await unsetConfigValue('global', 'relay.controlPlaneUrl', process.cwd());
      const p = await unsetConfigValue('project', 'relay.controlPlaneUrl', process.cwd());
      if (!g.existed && !p.existed) {
        log.info('No control plane was configured (relay.controlPlaneUrl not set).');
      } else {
        const where = [g.existed ? 'global' : null, p.existed ? 'project' : null]
          .filter(Boolean)
          .join(' + ');
        log.success(
          `Removed relay.controlPlaneUrl (${where}). New cloud boxes now push through the host relay ` +
            '(your laptop must be on), and the GitHub-App repo-authorization prompt no longer fires.',
        );
      }
      if (existsSync(CP_DIR)) {
        if (opts.purge) {
          // Same teardown `hub destroy` performs locally — including refreshing
          // the managed ssh config, which this used to skip and so left a
          // `Host agentbox-hub` block pointing at a machine you no longer use.
          await purgeLocalControlPlaneState({ dir: CP_DIR, keepCredentials: false });
          log.success(`Purged this machine's control-plane credentials (${CP_DIR}).`);
        } else {
          log.info(
            `This machine's App metadata + admin token remain in ${CP_DIR} (use --purge to delete).`,
          );
          log.info('To also delete the VPS itself, use `agentbox hub destroy`.');
        }
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

/** Reachability + box/event counts for a configured (remote) hub. */
export interface ControlPlaneStatus {
  url: string;
  healthy: boolean;
  boxes: number;
  events: number;
  detail: string;
  /**
   * The AgentBox version the remote hub is actually running, when it reports one.
   * Undefined for a control box deployed before the images exported
   * `AGENTBOX_CLI_VERSION` — callers fall back to the deploy record.
   */
  version?: string;
}

/**
 * Probe a remote hub's `/healthz` for reachability + box/event counts. Used by
 * the unified `agentbox hub status` when a control box is configured (the local
 * hub renders `getHubStatus()` instead). Never throws — an unreachable hub comes
 * back `healthy:false` with the error name in `detail`.
 */
export async function probeControlPlaneStatus(url: string): Promise<ControlPlaneStatus> {
  let healthy = false;
  let boxes = 0;
  let events = 0;
  let detail = '';
  let version: string | undefined;
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8000) });
    healthy = res.ok;
    const body = (await res.json().catch(() => ({}))) as {
      boxes?: number;
      events?: number;
      version?: string;
    };
    boxes = body.boxes ?? 0;
    events = body.events ?? 0;
    version = body.version;
    detail = `${String(boxes)} box(es), ${String(events)} event(s)`;
  } catch (e) {
    detail = e instanceof Error ? e.name : String(e);
  }
  return { url, healthy, boxes, events, detail, ...(version ? { version } : {}) };
}

const addSub = new Command('add')
  .description("Authorize the current project's git repo on the control plane's GitHub App")
  .action(async () => {
    try {
      const cfg = await loadEffectiveConfig(process.cwd());
      const controlPlaneUrl = cfg.effective.relay.controlPlaneUrl;
      if (!controlPlaneUrl) {
        log.error('No control plane configured. Run `agentbox hub set-url <url>` first.');
        process.exitCode = 1;
        return;
      }
      const ownerRepo = await resolveOwnerRepo(process.cwd());
      if (!ownerRepo) {
        log.error('No git origin found here — `cd` into a project with a GitHub remote.');
        process.exitCode = 1;
        return;
      }
      const { owner, repo } = ownerRepo;
      const installed = await checkRepoInstalled(owner, repo, controlPlaneUrl);
      if (installed === true) {
        log.success(`${owner}/${repo} is already authorized on the GitHub App.`);
        return;
      }
      const url = addRepoUrl(loadControlPlaneMeta());
      if (!url) {
        log.error(
          'No GitHub App metadata found locally. Run this from a machine that ran `hub setup`,\n' +
            'or open your App settings on GitHub and add the repo manually.',
        );
        process.exitCode = 1;
        return;
      }
      log.info(`Opening ${url} — select ${owner}/${repo}, then approve.`);
      openInBrowser(url);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

/** Run `git <args>`, rejecting on a non-zero exit. */
function runGit(args: string[], env?: Record<string, string>, timeoutMs?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : undefined;
    let err = '';
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} failed (${String(code)}): ${err.trim()}`));
    });
  });
}

interface WorkerOpts {
  store: string;
  once?: boolean;
  pollInterval: string;
}

const workerSub = new Command('worker')
  .description(
    'Drain the control plane box-creation queue and provision real boxes (long-running; needs provider creds + the App key)',
  )
  .requiredOption('--store <url>', 'Postgres URL of the control plane (same store the plane uses)')
  .option('--once', 'drain the queue once and exit (default: loop)')
  .option('--poll-interval <ms>', 'poll interval when looping', '5000')
  .action(async (opts: WorkerOpts) => {
    try {
      loadControlPlaneEnv();
      const store = new PostgresStore({ connectionString: opts.store });
      await store.migrate();
      const cfg = await loadEffectiveConfig(process.cwd());

      const createBox = makeControlPlaneCreateBox({
        // Per job, and App-optional — see the same comment in apps/hub/lib/hub-worker.ts.
        // Without an App the bare URL is returned and git's credential helper
        // (`gh auth setup-git` + GH_TOKEN) authenticates the clone.
        leaseRemoteUrl: async (repoUrl) => {
          const appCfg = loadGitHubAppConfig();
          if (!appCfg) return repoUrl;
          const { path } = parseGitRemote(repoUrl);
          const [owner, repo] = path.replace(/\.git$/, '').split('/');
          if (!owner || !repo) throw new Error(`cannot derive owner/repo from ${repoUrl}`);
          const { token } = await new GitHubAppLeaser(appCfg).leaseRepoToken(owner, repo);
          return toAuthedHttpsUrl(repoUrl, token);
        },
        cloneRepo: (authedUrl, repoUrl, dest, branch) =>
          cloneRepoWithLfs(runGit, authedUrl, repoUrl, dest, branch, (line) => log.info(line)),
        createBox: async ({ workspacePath, name, provider, agent, onLog }) => {
          const p = await providerForCreate({ flag: provider, config: cfg.effective });
          const created = await p.create({
            workspacePath,
            name,
            projectRoot: workspacePath,
            // Registered on the plane so an adopting PC relaunches the right agent.
            agent:
              agent === 'claude' || agent === 'codex' || agent === 'opencode' ? agent : undefined,
            onLog,
          });
          return { id: created.record.id };
        },
        // Overlay the project's custody seed onto the clone, exactly as the
        // resident hub worker does — without this, boxes drained by THIS worker
        // come up missing the untracked files + env material the seed exists to
        // provide. Unlike the hub, this worker is not the custody host, so it
        // reads the blobs over HTTP.
        fetchSeedMaterial: async (repoUrl, dest) => {
          const target = await resolveCustodyTarget(undefined, { quiet: true });
          if (!target) return null;
          const slug = projectSlugFromOriginUrl(repoUrl);
          if (!slug) return null;
          // Probe + bound like every other custody call: a down control box must
          // not park each blob `get` on undici's ~10s connect timeout and stall
          // a create the user is waiting on (see sandbox-cloud/reachability.ts).
          if (!(await hostReachable(target.url))) {
            process.stdout.write(
              'agentbox-cp-worker: control box unreachable — bare clone, no seed\n',
            );
            return null;
          }
          const client = new CustodyClient({
            ...target,
            fetchImpl: deadlineFetch(AbortSignal.timeout(SEED_FETCH_MS)),
          });
          return applyProjectSeed({
            source: { get: (rel) => client.get(`projects/${slug}/seed/${rel}`) },
            dest,
            log: (line) => process.stdout.write(`agentbox-cp-worker: ${line}\n`),
          });
        },
        tmpDir: (jobId) => join(tmpdir(), `agentbox-cp-worker-${jobId}`),
        cleanup: (dir) => rm(dir, { recursive: true, force: true }),
        log: (line) => process.stdout.write(`agentbox-cp-worker: ${line}\n`),
      });

      const workerId = `worker-${hostname()}-${String(process.pid)}`;
      const interval = Number.parseInt(opts.pollInterval, 10) || 5000;
      let running = true;
      const stop = (): void => {
        running = false;
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      process.stdout.write(`agentbox-cp-worker: draining create jobs as ${workerId}\n`);
      do {
        const n = await drainCreateJobs(store, createBox, workerId);
        if (n > 0) process.stdout.write(`agentbox-cp-worker: processed ${String(n)} job(s)\n`);
        if (opts.once) break;
        await delay(interval);
      } while (running);
      await store.close();
    } catch (err) {
      handleLifecycleError(err);
    }
  });

/**
 * Resolve the control-plane URL (`--url` > `relay.controlPlaneUrl`) and the
 * admin bearer (`AGENTBOX_RELAY_ADMIN_TOKEN` > the setup-written env file).
 * Returns null and prints an actionable error when either is missing.
 *
 * `quiet` suppresses those errors, for callers where a control box is optional
 * and its absence is a normal outcome rather than a user mistake (the recover
 * key fallback, the by-name auto-adopt hook).
 */
export async function resolveCustodyTarget(
  urlFlag: string | undefined,
  opts: { quiet?: boolean } = {},
): Promise<{ url: string; adminToken: string } | null> {
  const cfg = await loadEffectiveConfig(process.cwd());
  const configured = (urlFlag ?? cfg.effective.relay.controlPlaneUrl ?? '').replace(/\/$/, '');
  // A hub exposed on THIS machine is reached over loopback, not its box-facing URL.
  const url = (await applyLocalShortcut(configured, urlFlag)).replace(/\/$/, '');
  if (!url) {
    if (!opts.quiet)
      log.error('No control plane configured. Run `agentbox hub set-url <url>` (or pass --url).');
    return null;
  }
  loadControlPlaneEnv();
  const adminToken = process.env.AGENTBOX_RELAY_ADMIN_TOKEN ?? '';
  if (!adminToken) {
    if (!opts.quiet)
      log.error(
        'No admin token available. Set AGENTBOX_RELAY_ADMIN_TOKEN, or run this from the machine that\n' +
          'ran `agentbox hub setup` (it writes the token to ~/.agentbox/control-plane).',
      );
    return null;
  }
  return { url, adminToken };
}

/**
 * Bring the local hub up so it can answer `/api/v1`, returning true on success.
 * One spinner, one clear failure line — the autostart step behind
 * {@link resolveHubApiTarget} when the target resolves to a local hub that isn't
 * running yet.
 */
async function autostartLocalHub(): Promise<boolean> {
  // Dynamic import keeps control-plane.ts off a static edge to sandbox-docker
  // (the eventual Step 12 moves `ensureHub` to sandbox-core so a docker-free host
  // never pulls in docker machinery to start a hub).
  const { ensureHub } = await import('@agentbox/sandbox-docker');
  const s = spinner();
  s.start('starting local hub');
  try {
    const ep = await ensureHub({ onLog: (line) => s.message(line) });
    s.stop(`local hub running on ${ep.hostUrl}`);
    return true;
  } catch (err) {
    s.stop('local hub failed to start');
    log.error(err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Resolve the hub's public REST API target — its URL + the Bearer that authorizes
 * `/api/v1` — for BOTH modes. Delegates the local⇄remote decision to
 * {@link resolveHubTarget} (the same seam `agentbox hub target` and the tray
 * follow): a configured/exposed control box yields its `AGENTBOX_HUB_API_KEY`; a
 * local hub yields `~/.agentbox/hub/token`. The local hub's `proxy.ts` accepts
 * that token as `Authorization: Bearer`, so the returned target is URL-swappable
 * with a control box's with no client change.
 *
 * When the target is a local hub that isn't running, it is auto-started (unless
 * `quiet`, where a best-effort probe must not spawn a daemon). Returns null (with
 * an actionable error unless `quiet`) when a remote hub has no API key, or a local
 * hub can't be started / still reports no token.
 */
export async function resolveHubApiTarget(
  urlFlag: string | undefined,
  opts: { quiet?: boolean } = {},
): Promise<{ url: string; apiKey: string } | null> {
  // Lazy import breaks the hub.ts <-> control-plane.ts cycle: hub.ts consumes
  // `controlPlaneSubcommands` (defined at the bottom of this file) at load time,
  // so a static edge back the other way would read it before it's initialized.
  const { resolveHubTarget } = await import('./hub.js');
  let target = await resolveHubTarget(urlFlag);

  // Bring a local hub up before its token is used. The token at
  // `~/.agentbox/hub/token` PERSISTS across `hub stop`, so token presence is NOT a
  // liveness signal — a stopped hub still resolves with one. Gate the autostart on
  // the hub actually running, or a stopped hub would skip autostart and only fail
  // later at the health probe. Skipped under `quiet` (a probe must not spawn a
  // daemon). `getHubStatus` reflects only the local hub, so it is irrelevant in
  // remote mode.
  if (target.mode === 'local' && !opts.quiet) {
    const { getHubStatus } = await import('@agentbox/sandbox-docker');
    if (!(await getHubStatus()).running) {
      if (!(await autostartLocalHub())) return null;
      target = await resolveHubTarget(urlFlag);
    }
  }

  const resolved = hubApiTargetFrom(target);
  if (!resolved.ok) {
    if (!opts.quiet)
      log.error(
        resolved.mode === 'remote'
          ? 'No hub API key available. Set AGENTBOX_HUB_API_KEY, or run this from the machine that\n' +
              'ran `agentbox hub setup` (it writes the key to ~/.agentbox/control-plane).'
          : 'The local hub reports no API token. Start it with `agentbox hub` and retry.',
      );
    return null;
  }
  return { url: resolved.url, apiKey: resolved.apiKey };
}

/**
 * Build a {@link HubApiClient} for the configured hub from {@link resolveHubApiTarget}
 * (URL + `/api/v1` key), or null (with an actionable error unless `quiet`) when
 * unconfigured. The client-facing counterpart to `new ControlPlaneAdminClient`.
 */
export async function resolveHubApiClient(
  urlFlag: string | undefined,
  opts: { quiet?: boolean } = {},
): Promise<HubApiClient | null> {
  const target = await resolveHubApiTarget(urlFlag, opts);
  return target ? new HubApiClient(target) : null;
}

/**
 * Slug a project into a custody `projects/<slug>` key: `owner__repo`, else the
 * dir name.
 *
 * Delegates to the shared `projectSlugFromOriginUrl` — every producer and
 * consumer of the `projects/<slug>` scope MUST derive the same key from the same
 * origin, and a second local implementation is exactly how they drift apart. (It
 * did: this used to take the *first* two path segments unsanitized, while the
 * create path and the hub worker take the last two and sanitize — so for a
 * nested remote like `gitlab.com/group/subgroup/repo` a push landed under
 * `group__subgroup` while the worker looked in `subgroup__repo`.)
 */
async function projectSlug(explicit: string | undefined, projectRoot: string): Promise<string> {
  if (explicit) return explicit.replace(/[^A-Za-z0-9._-]/g, '-');
  const origin = await readGitOriginUrl(projectRoot).catch(() => undefined);
  const slug = origin ? projectSlugFromOriginUrl(origin) : null;
  if (slug) return slug;
  return basename(projectRoot).replace(/[^A-Za-z0-9._-]/g, '-') || 'project';
}

/** Upload a set of items with a hash-skip pass; logs one line per decision. */
async function pushItems(
  client: CustodyClient,
  items: UploadItem[],
  prefix: string,
  force: boolean,
): Promise<void> {
  if (items.length === 0) {
    log.info('Nothing to push.');
    return;
  }
  const manifest = await client.list(prefix);
  const plan = planPush(items, manifest, { force });
  let uploaded = 0;
  let skipped = 0;
  for (const item of items) {
    const decision = plan.find((d) => d.path === item.path)!;
    if (decision.action === 'skip') {
      skipped++;
      continue;
    }
    const res = await client.put(item.path, item.data);
    if (res.changed) uploaded++;
    else skipped++;
  }
  log.success(`Pushed ${String(uploaded)} item(s), skipped ${String(skipped)} unchanged.`);
}

const credentialsPushSub = new Command('push')
  .description(
    'Push host agent-credential backups (claude/codex/opencode) to the control box custody store',
  )
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .option('--agent <id>', 'push only one agent: claude | codex | opencode')
  .option('--force', 'upload even when the stored hash matches')
  .action(async (opts: { url?: string; agent?: string; force?: boolean }) => {
    try {
      const target = await resolveCustodyTarget(opts.url);
      if (!target) {
        process.exitCode = 1;
        return;
      }
      const only = opts.agent as 'claude' | 'codex' | 'opencode' | undefined;
      if (opts.agent && !['claude', 'codex', 'opencode'].includes(opts.agent)) {
        log.error(`unknown --agent "${opts.agent}" (expected claude | codex | opencode)`);
        process.exitCode = 1;
        return;
      }
      const items = await collectAgentCredentialUploads(only);
      const client = new CustodyClient(target);
      await pushItems(client, items, 'agents', opts.force === true);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const credentialsPullSub = new Command('pull')
  .description('Pull agent-credential backups from the control box custody store into ~/.agentbox')
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .option('--agent <id>', 'pull only one agent: claude | codex | opencode')
  .action(async (opts: { url?: string; agent?: string }) => {
    try {
      const target = await resolveCustodyTarget(opts.url);
      if (!target) {
        process.exitCode = 1;
        return;
      }
      if (opts.agent && !['claude', 'codex', 'opencode'].includes(opts.agent)) {
        log.error(`unknown --agent "${opts.agent}" (expected claude | codex | opencode)`);
        process.exitCode = 1;
        return;
      }
      const client = new CustodyClient(target);
      let pulled = 0;
      for (const spec of AGENT_SYNC_SPECS) {
        if (opts.agent && spec.id !== opts.agent) continue;
        const data = await client.get(`agents/${spec.id}/${spec.credential.boxRelPath}`);
        if (data === null) continue;
        await mkdir(dirname(spec.credential.hostBackup), { recursive: true });
        await writeFile(spec.credential.hostBackup, data, { mode: 0o600 });
        await chmod(spec.credential.hostBackup, 0o600);
        log.info(`pulled ${spec.id} credentials → ${spec.credential.hostBackup}`);
        pulled++;
      }
      if (pulled === 0) log.info('No agent credentials in custody to pull.');
      else log.success(`Pulled ${String(pulled)} agent credential set(s).`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const credentialsCmd = new Command('credentials')
  .description('Manage agent credentials on the control box custody store')
  .addCommand(credentialsPushSub)
  .addCommand(credentialsPullSub);

const secretsPushSub = new Command('push')
  .description('Push project secret/env files to the control box custody store')
  .argument('[files...]', 'files to push (default: ./.env if present)')
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .option(
    '--project <slug>',
    'custody project slug (default: owner__repo, else the directory name)',
  )
  .option('--force', 'upload even when the stored hash matches')
  .action(async (files: string[], opts: { url?: string; project?: string; force?: boolean }) => {
    try {
      const target = await resolveCustodyTarget(opts.url);
      if (!target) {
        process.exitCode = 1;
        return;
      }
      const root = process.cwd();
      const slug = await projectSlug(opts.project, root);
      const chosen =
        files.length > 0 ? files : existsSync(join(root, '.env')) ? [join(root, '.env')] : [];
      if (chosen.length === 0) {
        log.error('No files to push (no ./.env found; pass files explicitly).');
        process.exitCode = 1;
        return;
      }
      const items: UploadItem[] = [];
      for (const f of chosen) {
        items.push({ path: `projects/${slug}/${basename(f)}`, data: await readFile(f) });
      }
      const client = new CustodyClient(target);
      await pushItems(client, items, `projects/${slug}`, opts.force === true);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const secretsCmd = new Command('secrets')
  .description('Manage per-project secrets/envs on the control box custody store')
  .addCommand(secretsPushSub);

const projectPushSub = new Command('push')
  .description(
    "Push this project's seed material (untracked files + env/secrets) to the control box, so boxes created from its web UI get the files a fresh clone can't provide. A PC create does this automatically; run this to register a project before creating a box from it.",
  )
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .option(
    '--project <slug>',
    'custody project slug (default: owner__repo, else the directory name)',
  )
  .option('--force', 'upload even when the stored hash matches')
  .action(async (opts: { url?: string; project?: string; force?: boolean }) => {
    try {
      const target = await resolveCustodyTarget(opts.url);
      if (!target) {
        process.exitCode = 1;
        return;
      }
      const root = (await findProjectRoot(process.cwd())).root;
      const slug = await projectSlug(opts.project, root);
      const cfg = await loadEffectiveConfig(root).catch(() => null);
      const res = await pushProjectSeedToCustody({
        controlPlaneUrl: target.url,
        adminToken: target.adminToken,
        slug,
        projectRoot: root,
        // The default env set (same one `--with-env` uses). Unlike a create —
        // which mirrors that box's own wizard picks and must not widen them —
        // this command has no box and no picks: the user is explicitly asking to
        // register the project's seed, so the default set is the intent. What
        // actually gets captured is reported below.
        envPatterns: DEFAULT_ENV_PATTERNS,
        // Honour the configured cap, so raising it actually admits a bigger seed.
        maxBodyBytes: cfg?.effective.relay.custodyMaxBodyBytes,
        force: opts.force,
        log: (line) => log.info(line),
      });
      if (res.unreachable) {
        log.error(
          `Control box unreachable at ${target.url} — nothing was pushed. The project is NOT registered; re-run when it is up.`,
        );
        process.exitCode = 1;
        return;
      }
      const head = res.manifest.repoHeadSha?.slice(0, 8) ?? 'unknown';
      log.success(
        `Pushed ${String(res.uploaded)} item(s), skipped ${String(res.skipped)} unchanged → projects/${slug}/seed (at ${head}).`,
      );
      // Name the env files that went up. This command captures the default env
      // set rather than a per-box selection, so the user should never have to
      // guess which secrets now live on the control box.
      if (res.envFiles.length > 0) {
        log.info(`env/secret files captured: ${res.envFiles.join(', ')}`);
      }
      if (res.skippedTarBytes !== undefined) {
        log.warn(
          `The untracked-files tar (${String(Math.round(res.skippedTarBytes / 1024 / 1024))}MB) exceeded this machine's custody body cap and was NOT pushed — ` +
            'hub-created boxes will miss those files. To include it, raise `relay.custodyMaxBodyBytes` here AND ' +
            'AGENTBOX_CUSTODY_MAX_BODY_BYTES on the control box (it enforces its own cap).',
        );
      }
      if (res.dropped.length > 0) {
        log.warn(
          `The control box refused ${res.dropped.join(', ')} — hub-created boxes will miss those files. ` +
            'If it is a size limit, raise AGENTBOX_CUSTODY_MAX_BODY_BYTES on the control box.',
        );
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const projectCmd = new Command('project')
  .description('Manage a project on the control box (seed material for hub-created boxes)')
  .addCommand(projectPushSub);

const custodyListSub = new Command('list')
  .description('List custody entries (paths + hashes; values are never returned)')
  .argument('[prefix]', 'scope to a prefix, e.g. agents or projects/owner__repo')
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .action(async (prefix: string | undefined, opts: { url?: string }) => {
    try {
      const target = await resolveCustodyTarget(opts.url);
      if (!target) {
        process.exitCode = 1;
        return;
      }
      const client = new CustodyClient(target);
      const entries = await client.list(prefix);
      if (entries.length === 0) {
        log.info('No custody entries.');
        return;
      }
      for (const e of entries) {
        process.stdout.write(`${e.path}  ${String(e.size)}B  ${e.sha256.slice(0, 12)}\n`);
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const custodyPullSub = new Command('pull')
  .description('Download a custody scope to a local directory (0600 files)')
  .argument('<scope>', 'custody scope/prefix, e.g. agents, projects/owner__repo, boxes/<id>')
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .option('--dest <dir>', 'destination directory (default: ./agentbox-custody)')
  .action(async (scope: string, opts: { url?: string; dest?: string }) => {
    try {
      const target = await resolveCustodyTarget(opts.url);
      if (!target) {
        process.exitCode = 1;
        return;
      }
      const dest = opts.dest ?? join(process.cwd(), 'agentbox-custody');
      const client = new CustodyClient(target);
      const entries = await client.list(scope);
      if (entries.length === 0) {
        log.info(`No custody entries under '${scope}'.`);
        return;
      }
      let pulled = 0;
      for (const e of entries) {
        const data = await client.get(e.path);
        if (data === null) continue;
        const out = join(dest, e.path);
        await mkdir(dirname(out), { recursive: true, mode: 0o700 });
        await writeFile(out, data, { mode: 0o600 });
        await chmod(out, 0o600);
        pulled++;
      }
      log.success(
        `Pulled ${String(pulled)} entr${pulled === 1 ? 'y' : 'ies'} under '${scope}' to ${dest}.`,
      );
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const custodyRmSub = new Command('rm')
  .description('Delete a custody entry (one path) from the control box')
  .argument(
    '<path>',
    'custody path, e.g. boxes/<sandboxId>/ssh/id_ed25519 or agents/claude/.credentials.json',
  )
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .action(async (path: string, opts: { url?: string }) => {
    try {
      const target = await resolveCustodyTarget(opts.url);
      if (!target) {
        process.exitCode = 1;
        return;
      }
      const res = await fetch(
        `${target.url}/admin/custody/${path.split('/').map(encodeURIComponent).join('/')}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${target.adminToken}` },
        },
      );
      if (res.status === 204) log.success(`Deleted custody entry '${path}'.`);
      else if (res.status === 404) log.info(`No custody entry at '${path}'.`);
      else {
        log.error(
          `custody rm failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`,
        );
        process.exitCode = 1;
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const custodyCmd = new Command('custody')
  .description('Inspect + download the control box custody store')
  .addCommand(custodyListSub)
  .addCommand(custodyPullSub)
  .addCommand(custodyRmSub);

// --- control-plane box registry (the PC's admin view of the control box) ---

const boxesListSub = new Command('list')
  .description('List boxes on the hub (via its /api/v1) — a control box, or the local hub')
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .option('--json', 'print raw JSON')
  .action(async (opts: { url?: string; json?: boolean }) => {
    await withHubClient(opts, async (client) => {
      const boxes = await client.listBoxes();
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ boxes }, null, 2)}\n`);
        return;
      }
      if (boxes.length === 0) {
        log.info('No boxes on the hub.');
        return;
      }
      for (const b of boxes) {
        process.stdout.write(
          `${b.id}  ${b.name ?? b.task}  ${b.provider}  ${b.state ?? b.status}\n`,
        );
      }
    });
  });

const boxesRmSub = new Command('rm')
  .description(
    'Destroy a box via the hub (tears down the cloud resource AND reaps its registration/custody)',
  )
  .argument('<boxId>', 'the box id as shown by `hub boxes list`')
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .action(async (boxId: string, opts: { url?: string }) => {
    await withHubClient(opts, async (client) => {
      try {
        // Reverse-adoption on the control box means this drives a REAL destroy even
        // for a box created on the PC (registration-only) — not just a state reap.
        await client.destroy(boxId);
        log.success(`Destroyed '${boxId}' (cloud resource + hub state).`);
      } catch (err) {
        if (err instanceof HubApiError && err.code === 'not_found') {
          log.info(`No box '${boxId}' on the hub.`);
          return;
        }
        throw err;
      }
    });
  });

/** A `hub boxes <action>` lifecycle subcommand over the hub `/api/v1`. */
function boxesLifecycleSub(action: HubLifecycleAction, verb: string, past: string): Command {
  return new Command(action)
    .description(`${verb} a box on the hub (via its /api/v1)`)
    .argument('<boxId>', 'the box id as shown by `hub boxes list`')
    .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
    .action(async (boxId: string, opts: { url?: string }) => {
      await withHubClient(opts, async (client) => {
        try {
          await client.lifecycle(boxId, action);
          log.success(`${past} '${boxId}'.`);
        } catch (err) {
          if (err instanceof HubApiError && err.code === 'not_found') {
            log.info(`No box '${boxId}' on the hub.`);
            process.exitCode = 1;
            return;
          }
          throw err;
        }
      });
    });
}

const boxesCmd = new Command('boxes')
  .description(
    'List + drive boxes on the hub over its public /api/v1 (a control box, or the local hub)',
  )
  .addCommand(boxesListSub)
  .addCommand(boxesLifecycleSub('start', 'Start', 'Started'))
  .addCommand(boxesLifecycleSub('stop', 'Stop', 'Stopped'))
  .addCommand(boxesLifecycleSub('pause', 'Pause', 'Paused'))
  .addCommand(boxesLifecycleSub('resume', 'Resume', 'Resumed'))
  .addCommand(boxesRmSub);

// --- control-plane approvals (answerable from the PC over /api/v1) ---

const approvalsListSub = new Command('list')
  .description('List pending host-action approvals across control-box boxes')
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .option('--json', 'print raw JSON')
  .action(async (opts: { url?: string; json?: boolean }) => {
    try {
      const client = await resolveHubApiClient(opts.url);
      if (!client) {
        process.exitCode = 1;
        return;
      }
      // One call returns every pending approval (vs the admin wire's N per-box
      // fetches); cross-ref the box list once for human-readable names.
      const [approvals, boxes] = await Promise.all([
        client.listApprovals(),
        client.listBoxes().catch(() => []),
      ]);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(approvals, null, 2)}\n`);
        return;
      }
      if (approvals.length === 0) {
        log.info('No pending approvals.');
        return;
      }
      const nameBy = new Map(boxes.map((b) => [b.id, b.name ?? b.task]));
      for (const a of approvals) {
        process.stdout.write(`${a.id}  [${nameBy.get(a.boxId) ?? a.boxId}]  ${a.message}\n`);
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const approvalsAnswerSub = new Command('answer')
  .description('Answer a pending approval on the control box')
  .argument('<id>', 'the approval id from `hub approvals list`')
  .argument('[answer]', 'y | n (default: y)', 'y')
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .action(async (id: string, answer: string, opts: { url?: string }) => {
    try {
      if (answer !== 'y' && answer !== 'n') {
        log.error(`answer must be 'y' or 'n' (got '${answer}')`);
        process.exitCode = 1;
        return;
      }
      const client = await resolveHubApiClient(opts.url);
      if (!client) {
        process.exitCode = 1;
        return;
      }
      await client.answerApproval(id, answer);
      log.success(`Answered ${id} → ${answer}.`);
    } catch (err) {
      if (err instanceof HubApiError && err.code === 'not_found') {
        log.info(`No pending approval with id ${id} (already answered or expired?).`);
        process.exitCode = 1;
        return;
      }
      handleLifecycleError(err);
    }
  });

const approvalsCmd = new Command('approvals')
  .description('List + answer control-box host-action approvals from the PC')
  .addCommand(approvalsListSub)
  .addCommand(approvalsAnswerSub);

// --- control-plane create queue (distinct from the PC's local `-i` queue) ---

/** `<age> <status> <provider> <name/repo>` — one job per line. */
function jobLine(job: CreateJobRow): string {
  const label = job.request.name ?? job.request.repoUrl;
  const boxOrError =
    job.result?.error !== undefined
      ? `  ${job.result.error.split('\n')[0]?.slice(0, 80) ?? ''}`
      : job.result?.boxId
        ? `  box ${job.result.boxId}`
        : '';
  return `${job.id.slice(0, 8)}  ${job.status.padEnd(7)}  ${job.request.provider.padEnd(9)}  ${label}${boxOrError}`;
}

const jobsListSub = new Command('list')
  .description(
    'List create jobs on the control box. This is the queue that background `-i` cloud runs go to ' +
      "when a control box is configured — distinct from this PC's local `agentbox queue`.",
  )
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .option('--json', 'print raw JSON')
  .action(async (opts: { url?: string; json?: boolean }) => {
    try {
      const target = await resolveCustodyTarget(opts.url);
      if (!target) {
        process.exitCode = 1;
        return;
      }
      const jobs = await listHubJobs(target);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ jobs }, null, 2)}\n`);
        return;
      }
      if (jobs.length === 0) {
        log.info('No create jobs on the control box.');
        return;
      }
      for (const job of jobs) process.stdout.write(`${jobLine(job)}\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const jobsShowSub = new Command('show')
  .description('Dump one control-box create job')
  .argument('<jobId>', 'job id (or the short prefix `hub jobs list` prints)')
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .action(async (jobId: string, opts: { url?: string }) => {
    try {
      const target = await resolveCustodyTarget(opts.url);
      if (!target) {
        process.exitCode = 1;
        return;
      }
      // `jobs list` (and the `queue list` block) print an 8-char prefix, so the
      // id you can actually copy is not the full UUID the by-id route wants.
      // Try it verbatim first, then resolve it as a prefix.
      let job = await getHubJob(target, jobId);
      if (!job) {
        const matches = (await listHubJobs(target)).filter((j) => j.id.startsWith(jobId));
        if (matches.length > 1) {
          log.error(
            `'${jobId}' matches ${String(matches.length)} jobs (${matches.map((m) => m.id.slice(0, 12)).join(', ')}) — pass more of the id.`,
          );
          process.exitCode = 1;
          return;
        }
        job = matches[0] ?? null;
      }
      if (!job) {
        log.info(`No job '${jobId}' on the control box.`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${JSON.stringify(job, null, 2)}\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const jobsCmd = new Command('jobs')
  .description("Inspect the control box's box-create queue")
  .addCommand(jobsListSub)
  .addCommand(jobsShowSub);

interface DeployOpts {
  ref?: string;
  repo?: string;
  package?: string;
  domain?: string;
}

/**
 * Ensure `control-plane.env` carries a non-empty `AGENTBOX_HUB_API_KEY` (the
 * headless `/api/v1` bearer), minting + appending one if absent, and return it.
 * `setup` writes the key into a fresh env; this covers **redeploys** of a control
 * box whose env predates the key (or a hand-managed env), so every deploy — fresh
 * or repeat — ships a hub that accepts the headless key. Idempotent.
 */
async function ensureHubApiKeyInEnv(): Promise<string> {
  const body = await readFile(ENV_PATH, 'utf8');
  const existing = /^AGENTBOX_HUB_API_KEY=(.+)$/m.exec(body)?.[1]?.trim();
  if (existing) return existing;
  const key = randomBytes(32).toString('hex');
  const nl = body.length === 0 || body.endsWith('\n') ? '' : '\n';
  await writeFile(ENV_PATH, `${body}${nl}AGENTBOX_HUB_API_KEY=${key}\n`, { mode: 0o600 });
  await chmod(ENV_PATH, 0o600);
  return key;
}

// Re-deploy the FULL hub to a fresh Hetzner VPS, REUSING the existing
// ~/.agentbox/control-plane App creds + env — no GitHub-App manifest flow.
// Installs the published package by default; --ref/--repo switch to a VPS-side
// clone + build so a feature branch can be deployed for live verify.
//
// Note the deliberate absence of default values on --ref/--repo: an always-set
// flag would pin EVERY deploy to source mode, which is exactly what the default
// is meant to avoid.
const deployHetznerSub = new Command('hetzner')
  .description('Deploy the full hub to a new Hetzner VPS, reusing the App creds from `hub setup`')
  .option(
    '--ref <ref>',
    `build from source at this branch / tag / sha instead of installing the published package (${DEFAULT_DEPLOY_REF} matches this CLI)`,
  )
  .option(
    '--repo <url>',
    `git repo the VPS clones when building from source (default ${DEFAULT_DEPLOY_REPO})`,
  )
  .option(
    '--package <spec>',
    `npm spec of @madarco/agentbox to install (default ${AGENTBOX_VERSION}, this CLI's own version)`,
  )
  .option(
    '--domain <host>',
    'serve on a hostname you control (point its DNS at the VPS first) instead of the default <ip>.sslip.io',
  )
  .action(async (opts: DeployOpts) => {
    // Tee the spinner's progress to ~/.agentbox/logs/hub-deploy.log — a deploy
    // that dies at `compose up` or on a 502 otherwise leaves nothing to read.
    const cmdLog = openCommandLog('hub-deploy');
    try {
      if (!existsSync(ENV_PATH)) {
        log.error(
          'No control-plane env found. Run `agentbox hub setup` first (it creates the GitHub App + admin token).',
        );
        process.exitCode = 1;
        return;
      }
      if (!(await ensureHetznerHubAuth())) {
        log.warn('login prompt cancelled — deploying without web-UI auth.');
      }
      // Mint the headless /api/v1 bearer into the env if it isn't there yet, so a
      // redeploy of a pre-existing control box also gets it (setup writes it for
      // fresh installs). It rides the same scp'd .env into the container.
      await ensureHubApiKeyInEnv();
      const source = resolveHubDeploySource(AGENTBOX_VERSION, {
        ...(opts.ref ? { ref: opts.ref } : {}),
        ...(opts.repo ? { repoUrl: repoSlugToUrl(opts.repo) } : {}),
        ...(opts.package ? { packageSpec: opts.package } : {}),
      });
      if (source.kind === 'package' && source.spec !== AGENTBOX_VERSION) {
        log.warn(
          `deploying @madarco/agentbox@${source.spec}, which differs from this CLI (${AGENTBOX_VERSION}) — ` +
            'the host and the control box will run different builds.',
        );
      }
      const ds = spinner();
      ds.start('deploying the control box to hetzner');
      cmdLog.write(`hub source: ${describeHubDeploySource(source)}`);
      let deployedUrl: string;
      let provisioned: ControlPlaneDeployRecord | null = null;
      try {
        deployedUrl = (
          await runHetznerDeploy({
            envPath: ENV_PATH,
            source,
            ...(opts.domain ? { domain: opts.domain } : {}),
            log: (line) => {
              ds.message(line);
              cmdLog.write(line);
            },
            onProvisioned: (info) => {
              provisioned = info;
            },
          })
        ).url;
        ds.stop(`deployed: ${deployedUrl}`);
      } catch (e) {
        ds.stop('deploy failed');
        const msg = e instanceof Error ? e.message : String(e);
        cmdLog.write(`deploy failed: ${msg}`);
        log.error(msg);
        if (provisioned) note(recoveryHint(provisioned).join('\n'), 'Debug the VPS');
        log.info(`Full deploy log: ${cmdLog.path}`);
        process.exitCode = 1;
        return;
      }
      const url = await applyControlPlaneUrl(deployedUrl);
      log.success(`Pointed the CLI at ${url} (relay.controlPlaneUrl).`);
      const ok = await waitForHealthz(url, 60_000);
      log[ok ? 'success' : 'warn'](
        ok
          ? `Control box is healthy (${url}/healthz).`
          : `Could not confirm ${url}/healthz yet — check the deployment.`,
      );
      if (ok) await finalizeControlBoxState(url);
      log.info(`Reach the VPS with \`ssh ${AGENTBOX_HUB_SSH_ALIAS}\`. Deploy log: ${cmdLog.path}`);
    } catch (err) {
      cmdLog.write(`FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      handleLifecycleError(err);
    } finally {
      cmdLog.close();
    }
  });

interface DeployDigitalOceanOpts extends DeployOpts {
  region?: string;
  size?: string;
}

// The same full-hub docker-compose deploy as `hub deploy hetzner`, on a
// DigitalOcean Droplet. Reuses the ~/.agentbox/control-plane env + auth from
// `hub setup` — no GitHub-App manifest flow.
const deployDigitalOceanSub = new Command('digitalocean')
  .description(
    'Deploy the full hub to a new DigitalOcean Droplet, reusing the creds from `hub setup`',
  )
  .option(
    '--ref <ref>',
    `build from source at this branch / tag / sha instead of installing the published package (${DEFAULT_DEPLOY_REF} matches this CLI)`,
  )
  .option(
    '--repo <url>',
    `git repo the Droplet clones when building from source (default ${DEFAULT_DEPLOY_REPO})`,
  )
  .option(
    '--package <spec>',
    `npm spec of @madarco/agentbox to install (default ${AGENTBOX_VERSION}, this CLI's own version)`,
  )
  .option(
    '--domain <host>',
    'serve on a hostname you control (point its DNS at the Droplet first) instead of the default <ip>.sslip.io',
  )
  .option('--region <slug>', 'DigitalOcean region slug (default nyc3)')
  .option('--size <slug>', 'Droplet size slug (default s-2vcpu-4gb)')
  .action(async (opts: DeployDigitalOceanOpts) => {
    const cmdLog = openCommandLog('hub-deploy');
    try {
      if (!existsSync(ENV_PATH)) {
        log.error(
          'No control-plane env found. Run `agentbox hub setup` first (it writes the git credential + admin token).',
        );
        process.exitCode = 1;
        return;
      }
      if (!(await ensureHetznerHubAuth())) {
        log.warn('login prompt cancelled — deploying without web-UI auth.');
      }
      await ensureHubApiKeyInEnv();
      const source = resolveHubDeploySource(AGENTBOX_VERSION, {
        ...(opts.ref ? { ref: opts.ref } : {}),
        ...(opts.repo ? { repoUrl: repoSlugToUrl(opts.repo) } : {}),
        ...(opts.package ? { packageSpec: opts.package } : {}),
      });
      if (source.kind === 'package' && source.spec !== AGENTBOX_VERSION) {
        log.warn(
          `deploying @madarco/agentbox@${source.spec}, which differs from this CLI (${AGENTBOX_VERSION}) — ` +
            'the host and the control box will run different builds.',
        );
      }
      const ds = spinner();
      ds.start('deploying the control box to digitalocean');
      cmdLog.write(`hub source: ${describeHubDeploySource(source)}`);
      let deployedUrl: string;
      let provisioned: ControlPlaneDeployRecord | null = null;
      try {
        deployedUrl = (
          await runDigitalOceanDeploy({
            envPath: ENV_PATH,
            source,
            ...(opts.domain ? { domain: opts.domain } : {}),
            ...(opts.region ? { region: opts.region } : {}),
            ...(opts.size ? { size: opts.size } : {}),
            log: (line) => {
              ds.message(line);
              cmdLog.write(line);
            },
            onProvisioned: (info) => {
              provisioned = info;
            },
          })
        ).url;
        ds.stop(`deployed: ${deployedUrl}`);
      } catch (e) {
        ds.stop('deploy failed');
        const msg = e instanceof Error ? e.message : String(e);
        cmdLog.write(`deploy failed: ${msg}`);
        log.error(msg);
        if (provisioned) note(recoveryHintDigitalOcean(provisioned).join('\n'), 'Debug the VPS');
        log.info(`Full deploy log: ${cmdLog.path}`);
        process.exitCode = 1;
        return;
      }
      const url = await applyControlPlaneUrl(deployedUrl);
      log.success(`Pointed the CLI at ${url} (relay.controlPlaneUrl).`);
      const ok = await waitForHealthz(url, 60_000);
      log[ok ? 'success' : 'warn'](
        ok
          ? `Control box is healthy (${url}/healthz).`
          : `Could not confirm ${url}/healthz yet — check the deployment.`,
      );
      if (ok) await finalizeControlBoxState(url);
      log.info(
        `Reach the Droplet with \`ssh ${AGENTBOX_HUB_SSH_ALIAS}\`. Deploy log: ${cmdLog.path}`,
      );
    } catch (err) {
      cmdLog.write(`FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      handleLifecycleError(err);
    } finally {
      cmdLog.close();
    }
  });

interface UpdateOpts {
  ref?: string;
  repo?: string;
  package?: string;
  channel?: string;
  yes?: boolean;
}

/**
 * Resolve `--channel` to a concrete published version, so the control box is
 * pinned to an exact build the way `hub deploy` pins it. Mirrors `self-update`:
 * the newest build on a channel can live under either dist-tag, so install the
 * resolved VERSION rather than the tag.
 */
async function specForChannel(channel: string): Promise<string> {
  if (channel !== 'nightly' && channel !== 'stable') {
    throw new Error(`unknown --channel "${channel}" (expected: nightly | stable)`);
  }
  const best = await fetchNpmBest(channel);
  if (!best) {
    throw new Error(`could not reach the npm registry to resolve the newest ${channel} build`);
  }
  return best;
}

/**
 * `hub update` for a LOCAL control box. Its "build" is this CLI's own hub
 * bundle, so an update restarts the exposed hub in place. Changing the machine's
 * AgentBox build is `agentbox self-update` — a whole-machine action, not this
 * command's job — so a spec flag here just points there.
 */
async function runLocalUpdateFlow(opts: UpdateOpts, logWrite: (l: string) => void): Promise<void> {
  if (opts.channel || opts.package || opts.ref || opts.repo) {
    log.warn(
      "This control box IS this machine's hub, so its build is this CLI. To change the build, run " +
        '`agentbox self-update` (it reloads the hub too); `hub update` just restarts the exposed hub.',
    );
  }
  const loopback = (await localExposedLoopbackUrl()) ?? 'http://127.0.0.1:8787';
  const before = await probeControlPlaneStatus(loopback);
  log.info(`control box: this machine (${loopback}) — ${before.version ?? 'running'}`);
  if (!opts.yes) {
    const ok = await confirm({ message: 'Restart the exposed hub?', initialValue: true });
    if (isCancel(ok) || !ok) {
      log.info('cancelled');
      return;
    }
  }
  await ensureHubApiKeyInEnv();
  const s = spinner();
  s.start('restarting the exposed hub');
  try {
    await runLocalUpdate((l) => {
      s.message(l);
      logWrite(l);
    });
    s.stop('exposed hub restarted');
  } catch (e) {
    s.stop('restart failed', 1);
    log.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return;
  }
  const after = await probeControlPlaneStatus(loopback);
  log[after.healthy ? 'success' : 'warn'](
    after.healthy
      ? `Control box is healthy${after.version ? `, running ${after.version}` : ''}.`
      : `Hub did not answer just now (${after.detail}) — check with \`agentbox hub status\`.`,
  );
  await syncBakesWithControlBox(loopback);
}

/** `hub destroy` for a LOCAL control box: stop exposing, revert to the plain hub. */
async function runLocalDestroyFlow(
  record: ControlPlaneDeployRecord,
  opts: DestroyOpts,
): Promise<void> {
  const loopback = `http://127.0.0.1:${String(record.port ?? 8787)}`;
  // Registered cloud boxes outlive the hub and its store may be their only
  // record — the same hard gate as the VPS path, probed over loopback.
  const boxes = await listHubBoxesForDestroy({ ...record, url: loopback });
  const gate = destroyGate(boxes, Boolean(opts.force));
  if (!gate.allowed) {
    log.error(
      `The control box still has ${String(gate.orphanCount)} box(es) registered. Stopping it now would orphan them:`,
    );
    for (const b of gate.orphans) {
      process.stdout.write(`  ${b.id}  ${b.name ?? ''}  ${b.provider ?? ''}  ${b.state ?? ''}\n`);
    }
    log.info('Destroy them first (`agentbox hub boxes rm <id>`), or re-run with --force.');
    process.exitCode = 1;
    return;
  }
  const lines = [
    'stop exposing (the plain localhost hub returns on the next `agentbox hub start`)',
    'the tunnel + autostart unit, if any',
    opts.keepCredentials
      ? `${CP_DIR}/deploy.json (control-plane.env kept — 'hub expose' again needs no setup)`
      : `${CP_DIR} (credentials + deploy record)`,
    'relay.controlPlaneUrl (global + project)',
    'The shared ~/.agentbox (store.db / custody / boxes) is kept.',
  ];
  if (gate.note) lines.push(`NOTE: ${gate.note}`);
  note(lines.join('\n'), 'This will');
  if (!opts.yes) {
    const ok = await confirm({ message: 'Stop being the control box?', initialValue: false });
    if (isCancel(ok) || !ok) {
      log.info('cancelled');
      return;
    }
  }
  await runLocalDestroy({
    keepCredentials: Boolean(opts.keepCredentials),
    log: (l) => log.info(l),
  });
  log.success(
    'This machine is no longer the control box — the plain localhost hub is back on the next `agentbox hub start`.',
  );
  if (opts.keepCredentials) {
    log.info(
      `Credentials kept in ${CP_DIR} — \`agentbox hub expose\` re-exposes without \`hub setup\`.`,
    );
  }
}

const updateSub = new Command('update')
  .description('Update the deployed control box in place to a new AgentBox build')
  .option('--channel <nightly|stable>', 'install the newest published build on this channel')
  .option(
    '--package <spec>',
    `npm spec to install (default ${AGENTBOX_VERSION}, this CLI's own version)`,
  )
  .option('--ref <ref>', 'switch the control box to building from source at this git ref')
  .option('--repo <url>', 'git repo the VPS clones when building from source')
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(async (opts: UpdateOpts) => {
    const cmdLog = openCommandLog('hub-update');
    try {
      if (!existsSync(ENV_PATH)) {
        log.error('No control-plane env found. Run `agentbox hub setup` first.');
        process.exitCode = 1;
        return;
      }
      const record = await readDeployRecord();

      // A local control box IS this machine's hub — its "build" is this CLI, so
      // an update restarts the exposed hub in place. Changing the CLI build is a
      // separate whole-machine action (`agentbox self-update`).
      if (record?.provider === 'local') {
        await runLocalUpdateFlow(opts, cmdLog.write.bind(cmdLog));
        return;
      }

      assertReachableRecord(record);

      const source = opts.channel
        ? ({ kind: 'package', spec: await specForChannel(opts.channel) } as const)
        : resolveHubDeploySource(AGENTBOX_VERSION, {
            ...(opts.ref ? { ref: opts.ref } : {}),
            ...(opts.repo ? { repoUrl: repoSlugToUrl(opts.repo) } : {}),
            ...(opts.package ? { packageSpec: opts.package } : {}),
          });

      // What it runs NOW comes from the live hub when it can answer — the record
      // only says what was last *deployed*, which is wrong if a previous update
      // failed halfway.
      const live = await probeControlPlaneStatus(record.url);
      const from = live.version ?? describeRecordedSource(record) ?? 'unknown';
      log.info(`control box: ${record.url} (server ${String(record.serverId ?? '?')})`);
      log.info(`  ${from}  →  ${describeHubDeploySource(source)}`);
      if (!live.healthy) {
        log.warn('The hub is not answering right now — updating anyway will also restart it.');
      }
      if (!opts.yes) {
        const ok = await confirm({ message: 'Update the control box?', initialValue: true });
        if (isCancel(ok) || !ok) {
          log.info('cancelled');
          return;
        }
      }

      // Pick up keys added by CLI versions newer than the one that deployed this
      // box (the same gap `hub deploy hetzner` covers for a redeploy).
      await ensureHubApiKeyInEnv();

      const isDigitalOcean = record.provider === 'digitalocean';
      const runVpsUpdate = isDigitalOcean ? runDigitalOceanUpdate : runHetznerUpdate;
      const updateHint = isDigitalOcean ? recoveryHintDigitalOcean : recoveryHint;
      const ds = spinner();
      ds.start(`updating the control box${isDigitalOcean ? ' (digitalocean)' : ''}`);
      cmdLog.write(`hub update: ${from} -> ${describeHubDeploySource(source)}`);
      try {
        await runVpsUpdate({
          envPath: ENV_PATH,
          source,
          log: (line) => {
            ds.message(line);
            cmdLog.write(line);
          },
        });
        ds.stop(`updated: ${record.url}`);
      } catch (e) {
        ds.stop('update failed');
        const msg = e instanceof Error ? e.message : String(e);
        cmdLog.write(`update failed: ${msg}`);
        log.error(msg);
        note(updateHint(record).join('\n'), 'Debug the VPS');
        log.info(`Full update log: ${cmdLog.path}`);
        process.exitCode = 1;
        return;
      }
      // Report what the probe actually found. The update already waited for a
      // healthy hub, so a failing probe here is usually transient — but claiming
      // health from a probe that failed is exactly the false success this whole
      // command was just taught to avoid.
      const after = await probeControlPlaneStatus(record.url);
      if (!after.healthy) {
        log.warn(
          `Update applied, but ${record.url}/healthz did not answer just now (${after.detail}). Re-check with \`agentbox hub status\`.`,
        );
      } else {
        log.success(
          after.version
            ? `Control box is healthy, running ${after.version}.`
            : `Control box is healthy (${record.url}/healthz).`,
        );
      }
      // A version change is exactly when a shared bake record starts (or stops)
      // matching the control box's fingerprint, so re-share.
      await syncBakesWithControlBox(record.url);
    } catch (err) {
      cmdLog.write(`FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      handleLifecycleError(err);
    } finally {
      cmdLog.close();
    }
  });

/** The build `deploy.json` last recorded, as one line. */
function describeRecordedSource(record: ControlPlaneDeployRecord): string | null {
  if (!record.source) return null;
  return record.source.kind === 'package'
    ? `@madarco/agentbox@${record.source.spec}`
    : `${record.source.repoUrl}@${record.source.repoRef}`;
}

interface DestroyOpts {
  yes?: boolean;
  force?: boolean;
  keepCredentials?: boolean;
}

/**
 * `hub unexpose` — the friendly name for tearing down a LOCAL control box.
 *
 * It is the same flow as `hub destroy`, which is deliberate: there is one
 * teardown, not two. But "destroy" reads as data loss when the control box is
 * your own laptop, where the honest description is "stop exposing" — nothing is
 * deleted except the exposed mode itself (the shared `~/.agentbox` stays).
 */
const unexposeSub = new Command('unexpose')
  .description('Stop this machine being the control box (the plain localhost hub returns)')
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--force', 'stop even while the hub still has boxes registered')
  .option('--keep-credentials', 'keep control-plane.env so `hub expose` needs no setup again')
  .action(async (opts: DestroyOpts) => {
    try {
      const record = await readDeployRecord();
      if (record?.provider !== 'local') {
        log.error(
          record
            ? 'This machine is not the control box — the configured one is a deployed VPS. Use `agentbox hub destroy` to tear that down.'
            : 'This machine is not exposed as a control box (nothing to undo).',
        );
        process.exitCode = 1;
        return;
      }
      await runLocalDestroyFlow(record, opts);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const destroySub = new Command('destroy')
  .description(
    "Tear down the control box: a deployed VPS + its firewall, or this machine's exposed hub, plus the local state",
  )
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--force', 'destroy even while the hub still has boxes registered')
  .option('--keep-credentials', 'keep control-plane.env so a redeploy needs no `hub setup`')
  .action(async (opts: DestroyOpts) => {
    try {
      const record = await readDeployRecord();
      if (!record) {
        log.error(
          'No control box was deployed from this machine (~/.agentbox/control-plane/deploy.json is missing).',
        );
        log.info(
          'To stop using a hub configured with `hub set-url`, run `agentbox hub unset-url`.',
        );
        process.exitCode = 1;
        return;
      }

      if (record.provider === 'local') {
        await runLocalDestroyFlow(record, opts);
        return;
      }

      // Cloud boxes the hub created outlive it, and its store is often the only
      // record they exist — so enumerate before destroying it, not after.
      const boxes = await listHubBoxesForDestroy(record);
      const gate = destroyGate(boxes, Boolean(opts.force));
      if (!gate.allowed) {
        log.error(
          `The control box still has ${String(gate.orphanCount)} box(es) registered. Destroying it now would orphan them:`,
        );
        for (const b of gate.orphans) {
          process.stdout.write(
            `  ${b.id}  ${b.name ?? ''}  ${b.provider ?? ''}  ${b.state ?? ''}\n`,
          );
        }
        log.info('Destroy them first (`agentbox hub boxes rm <id>`), or re-run with --force.');
        process.exitCode = 1;
        return;
      }

      const isDigitalOcean = record.provider === 'digitalocean';
      const cloudLabel = isDigitalOcean ? 'DigitalOcean' : 'Hetzner';
      const serverKind = isDigitalOcean ? 'droplet' : 'server';
      const lines = [
        `${cloudLabel} ${serverKind} ${String(record.serverId ?? '?')} (${record.ip ?? '?'})`,
        ...(record.firewallId !== undefined
          ? [`${cloudLabel} firewall ${String(record.firewallId)}`]
          : []),
        opts.keepCredentials
          ? `${CP_DIR}/deploy.json + ssh/ (control-plane.env kept)`
          : `${CP_DIR} (credentials, ssh key, deploy record)`,
        `the \`${AGENTBOX_HUB_SSH_ALIAS}\` SSH alias`,
        'relay.controlPlaneUrl (global + project)',
      ];
      if (gate.note) lines.push(`NOTE: ${gate.note}`);
      note(lines.join('\n'), 'This will delete');

      if (!opts.yes) {
        const ok = await confirm({ message: 'Destroy the control box?', initialValue: false });
        if (isCancel(ok) || !ok) {
          log.info('cancelled');
          return;
        }
      }

      const result = isDigitalOcean
        ? await runDigitalOceanDestroy({ record, log: (l) => log.info(l) })
        : await runHetznerDestroy({ record, log: (l) => log.info(l) });
      for (const w of result.warnings) log.warn(w);
      // Purge regardless: a server that was already deleted by hand must not
      // leave this machine pointing at it with no way to clear the state.
      await purgeLocalControlPlaneState({
        dir: CP_DIR,
        keepCredentials: Boolean(opts.keepCredentials),
      });
      await unsetConfigValue('global', 'relay.controlPlaneUrl', process.cwd());
      await unsetConfigValue('project', 'relay.controlPlaneUrl', process.cwd());

      log.success('Control box destroyed. Cloud boxes now build on this machine again.');
      if (opts.keepCredentials) {
        log.info(
          `Credentials kept in ${CP_DIR} — \`agentbox hub deploy ${isDigitalOcean ? 'digitalocean' : 'hetzner'}\` redeploys without \`hub setup\`.`,
        );
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

/** Boxes the hub still owns, or why we couldn't ask. */
export type HubBoxesProbe =
  | { kind: 'boxes'; rows: Array<{ id: string; name?: string; provider?: string; state?: string }> }
  | { kind: 'unreachable'; reason: string };

/**
 * Whether `hub destroy` may proceed.
 *
 * Cloud boxes the control box created keep running in their provider, and the
 * hub's store is often the only record they exist — so a non-empty list is a
 * hard stop rather than a warning. An **unreachable** hub is not: a deploy that
 * never came up is the single most common thing people want to delete, and
 * refusing there would leave no way to clean up at all.
 *
 * Pure so the gate is testable without a live hub.
 */
export function destroyGate(
  probe: HubBoxesProbe,
  force: boolean,
): {
  allowed: boolean;
  orphanCount: number;
  note: string | null;
  orphans: Array<{ id: string; name?: string; provider?: string; state?: string }>;
} {
  if (probe.kind === 'unreachable') {
    return {
      allowed: true,
      orphanCount: 0,
      orphans: [],
      note: `the hub did not answer, so its boxes could not be listed (${probe.reason})`,
    };
  }
  // Only boxes that would actually be stranded count. A local `docker` box runs
  // on this machine against the host's own `.git` and is never handed to the
  // control box, so losing the hub does not orphan it — gating on it made an
  // exposed hub refuse to stand down because of a container sitting next to it.
  // `remote-docker` is NOT exempt: that one lives on another machine.
  const orphans = probe.rows.filter((b) => b.provider !== 'docker');
  const orphanCount = orphans.length;
  if (orphanCount === 0) return { allowed: true, orphanCount: 0, orphans: [], note: null };
  if (!force) return { allowed: false, orphanCount, orphans, note: null };
  return {
    allowed: true,
    orphanCount,
    orphans,
    note: `--force — ${String(orphanCount)} registered box(es) will be orphaned`,
  };
}

async function listHubBoxesForDestroy(record: ControlPlaneDeployRecord): Promise<HubBoxesProbe> {
  if (!record.url) return { kind: 'unreachable', reason: 'no url in the deploy record' };
  try {
    // Pin to the record's URL rather than the configured one: destroy must ask
    // the box it is about to delete, even if `relay.controlPlaneUrl` has since
    // been pointed somewhere else.
    const client = await resolveHubApiClient(record.url, { quiet: true });
    if (!client) return { kind: 'unreachable', reason: 'no /api/v1 key configured for this hub' };
    return { kind: 'boxes', rows: await client.listBoxes() };
  } catch (e) {
    return { kind: 'unreachable', reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * This CLI's live native fingerprint for a provider's base build context, or
 * undefined when it can't be computed (a dev tree with no staged runtime, or a
 * provider that doesn't fingerprint). Loads the module WITHOUT its credential
 * gate — `baseFingerprint` only hashes the staged runtime files, no SDK/network.
 */
async function cliNativeFingerprint(provider: string): Promise<string | undefined> {
  try {
    return await (await loadProviderModule(provider)).provider.baseFingerprint?.('native');
  } catch {
    return undefined;
  }
}

/**
 * Reconcile this machine's cloud bake records with a control box's, in BOTH
 * directions, so whichever side already baked this build context settles it.
 *
 * Per provider:
 *   - our record matches this CLI's build context → **push** it, so the box's
 *     first web-UI create boots it instead of spending minutes re-baking.
 *   - it doesn't → **pull** first. A CLI update moves the build context, which
 *     staled every local cloud base at once; when the box already holds one for
 *     the new context, adopting it costs a GET instead of a multi-minute bake.
 *     Sharing used to be push-only, so this case only ever produced a nag.
 *   - neither side has one → say so, once, per provider.
 *
 * The push always succeeds if the box is reachable, but the box only ADOPTS a
 * record whose build-context fingerprint matches its own — so a record from a
 * different build context (an older local bake, or a hub on a different version)
 * is uploaded and then ignored, and the hub re-bakes. `classifyBakeShare`
 * predicts that here so setup ends with an explicit per-provider message rather
 * than a silent "shared it" that isn't the whole truth.
 *
 * Best-effort: a fresh deploy is still perfectly usable without any of this (it
 * just bakes on demand).
 */
async function syncBakesWithControlBox(url: string | undefined): Promise<void> {
  const target = await resolveCustodyTarget(url, { quiet: true });
  if (!target) return;
  // The version the box actually runs decides whether its fingerprint matches
  // ours; a box that doesn't report one leaves the version-skew check inert.
  const hubVersion = (await probeControlPlaneStatus(target.url)).version;
  const results: BakeShareResult[] = [];
  // Derive the provider set from the live runtime registry (built-ins AND
  // registered plugins) filtered by the single shareable rule — never a
  // hardcoded list, or a new provider is silently skipped from bake sharing.
  const providers = getRuntimeProviderNames().filter(isShareablePreparedProvider);
  // The pull direction first, in one sweep: it skips any provider whose local
  // record is already current, so it only ever touches the ones a push couldn't
  // help with anyway. Imported lazily — `prepared-custody` reaches back here for
  // `resolveCustodyTarget`, and a static edge both ways is a module cycle.
  const { adoptPreparedBases } = await import('../control-plane/prepared-custody.js');
  const pulled = await adoptPreparedBases().catch(() => ({
    adopted: [] as string[],
    pending: [] as string[],
  }));
  for (const provider of providers) {
    const adopted = pulled.adopted.includes(provider);
    // Read AFTER the sweep — an adopted record is the current local one.
    const local = readPreparedStateRaw(provider) as { base?: { contextSha256?: string } } | null;
    const storedFingerprint = local?.base?.contextSha256;
    const liveFingerprint = await cliNativeFingerprint(provider);
    if (!adopted && !storedFingerprint) continue; // nothing here, nothing there
    // Capture the real upload outcome — a swallowed failure must not be reported
    // as a share (the record never left this machine, so the hub will re-bake).
    const pushSucceeded =
      !adopted && storedFingerprint
        ? await pushPreparedToCustody(provider, {
            controlPlaneUrl: target.url,
            adminToken: target.adminToken,
          }).catch(() => false)
        : false;
    results.push(
      classifyBakeShare({
        provider,
        storedFingerprint,
        cliNativeFingerprint: liveFingerprint,
        hubVersion,
        cliVersion: AGENTBOX_VERSION,
        pushSucceeded,
        adopted,
      }),
    );
  }
  const { matched, adopted, mismatched, shareFailed } = summarizeBakeShare(results);
  if (matched.length > 0) {
    log.success(
      `Shared your ${matched.join(', ')} base bake(s) with the control box — it won't re-bake them.`,
    );
  }
  if (adopted.length > 0) {
    log.success(
      `Adopted the control box's ${adopted.join(', ')} base bake(s) — no re-bake needed here.`,
    );
  }
  const rebakeNote = buildRebakeNote(mismatched);
  if (rebakeNote) log.warn(rebakeNote);
  const failedNote = buildShareFailedNote(shareFailed);
  if (failedNote) log.warn(failedNote);
}

/** Bound on a credential-sync round-trip once the control box is known to be up. */
const CREDENTIAL_SYNC_FETCH_MS = 15_000;

/**
 * Push host agent-credential backups (claude/codex/opencode) to the control box,
 * hash-skipping unchanged blobs — the same work `hub credentials push` does, so
 * a hub-created box is never launched loginless.
 *
 * `announce` picks the failure policy:
 *   - `true` (end of `hub setup`/`deploy`): report what went up; on failure WARN
 *     and name the manual command — never throw, so it can't fail the setup.
 *   - `false` (change-detected re-push): silent when nothing changed, and every
 *     error is swallowed — a stale-cred refresh must never break the command
 *     that triggered it.
 *
 * Returns the number of credential sets uploaded (0 when unchanged / no box).
 */
async function syncAgentCredentials(
  url: string | undefined,
  opts: { announce: boolean },
): Promise<number> {
  try {
    const target = await resolveCustodyTarget(url, { quiet: true });
    if (!target) {
      if (opts.announce) {
        log.warn(
          'No control box reachable, so agent credentials were not pushed. Run `agentbox hub credentials push` once it is up.',
        );
      }
      return 0;
    }
    // A down box must not park the sync on undici's ~10s connect timeout: probe
    // first, then bound every custody call.
    if (!(await hostReachable(target.url))) {
      if (opts.announce) {
        log.warn(
          `Control box unreachable at ${target.url}, so agent credentials were not pushed. Run \`agentbox hub credentials push\` once it is up.`,
        );
      }
      return 0;
    }
    const items = await collectAgentCredentialUploads();
    if (items.length === 0) {
      if (opts.announce) {
        log.info(
          'No host agent logins to push yet — sign in with `agentbox claude login`, then `agentbox hub credentials push`.',
        );
      }
      return 0;
    }
    const client = new CustodyClient({
      ...target,
      fetchImpl: deadlineFetch(AbortSignal.timeout(CREDENTIAL_SYNC_FETCH_MS)),
    });
    const plan = planPush(items, await client.list('agents'), {});
    if (!hasCredentialChanges(plan)) {
      if (opts.announce) log.info('Agent logins already up to date on the control box.');
      return 0;
    }
    const uploaded = new Set<string>();
    for (const item of items) {
      if (plan.find((d) => d.path === item.path)?.action !== 'upload') continue;
      await client.put(item.path, item.data);
      // `agents/<id>/<file>` → the agent id.
      uploaded.add(item.path.split('/')[1] ?? item.path);
    }
    if (opts.announce && uploaded.size > 0) {
      log.success(`Pushed ${[...uploaded].join(', ')} login(s) to the control box.`);
    }
    return uploaded.size;
  } catch (err) {
    if (opts.announce) {
      log.warn(
        `Could not push agent credentials to the control box (${err instanceof Error ? err.message : String(err)}). ` +
          'Run `agentbox hub credentials push` manually.',
      );
    }
    return 0;
  }
}

/**
 * Best-effort, silent-when-unchanged credential re-push, for the points where a
 * stale login on the control box actually bites: a cloud create routed to the
 * hub, and a fresh `agentbox claude login`. Cheap (hash compare, skips when the
 * host backup hasn't changed) and never throws — a no-op when no control box is
 * configured. Reuses the existing custody client + relay, no new channel.
 */
export async function syncAgentCredentialsIfChanged(url?: string): Promise<void> {
  await syncAgentCredentials(url, { announce: false });
}

/**
 * The end-of-setup/deploy step for a control box that just came up: get its
 * agent logins and bake records in place so its first hub-created box is signed
 * in and boots a baked base rather than re-baking. Both steps are best-effort
 * and self-reporting; neither fails the setup. `url` is undefined for a local
 * exposed hub (resolved to loopback by the custody target).
 */
async function finalizeControlBoxState(url: string | undefined): Promise<void> {
  await syncAgentCredentials(url, { announce: true });
  await syncBakesWithControlBox(url);
}

const deployCmd = new Command('deploy')
  .description('Deploy the full hub to a VPS, reusing the App creds from `hub setup`')
  .addCommand(deployHetznerSub)
  .addCommand(deployDigitalOceanSub);

/**
 * The remote-hub admin subcommands, folded into the one `hub` command group
 * (`apps/cli/src/commands/hub.ts`). AgentBox is unreleased, so there is no
 * standalone `control-plane` group anymore — `hub setup`/`hub deploy`/`hub boxes`
 * etc. are the single surface. `status` is not here: it merged into `hub status`
 * (local process vs remote reachability, resolved by target).
 */
export const controlPlaneSubcommands = [
  setupSub,
  exposeSub,
  deployCmd,
  updateSub,
  destroySub,
  unexposeSub,
  setUrlSub,
  unsetUrlSub,
  addSub,
  workerSub,
  credentialsCmd,
  secretsCmd,
  projectCmd,
  custodyCmd,
  boxesCmd,
  approvalsCmd,
  jobsCmd,
] as const;
