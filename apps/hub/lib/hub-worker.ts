/**
 * Resident create worker for the control box (hetzner profile). Runs IN the hub
 * process — the SQLite single-writer constraint (phase 1) means the queue's
 * consumer must share the store, not contend on the file from a second
 * container. Gated by `AGENTBOX_HUB_WORKER=on`; the localhost profile never
 * starts it.
 *
 * It builds a `CreateBoxFn` from the shared `makeControlPlaneCreateBox`
 * orchestration (lease → local clone → `provider.create`) and drains the
 * `/remote/boxes` queue on an interval. Node-only — loaded by `server.ts`, never
 * by Next.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { isProviderKind, type ProviderKind } from '@agentbox/config';
import {
  drainCreateJobs,
  FsCustodyStore,
  GitHubAppLeaser,
  loadGitHubAppConfig,
  makeControlPlaneCreateBox,
  parseGitRemote,
  toAuthedHttpsUrl,
  type CreateBoxFn,
  type Store,
} from '@agentbox/relay/control-plane';
import { AGENT_SYNC_SPECS, defaultBoxSshDir } from '@agentbox/sandbox-core';
import type { ProviderModule } from '@agentbox/sandbox-core';

const execFileAsync = promisify(execFile);

// Same provider importer map the hub backend uses (an app can't reach
// apps/cli's provider registry). Only cloud providers make sense for the worker.
const IMPORTERS: Record<ProviderKind, () => Promise<{ providerModule: ProviderModule }>> = {
  docker: () => import('@agentbox/sandbox-docker'),
  daytona: () => import('@agentbox/sandbox-daytona'),
  hetzner: () => import('@agentbox/sandbox-hetzner'),
  vercel: () => import('@agentbox/sandbox-vercel'),
  e2b: () => import('@agentbox/sandbox-e2b'),
  digitalocean: () => import('@agentbox/sandbox-digitalocean'),
  'remote-docker': () => import('@agentbox/sandbox-remote-docker'),
};

async function runGit(args: string[]): Promise<void> {
  await execFileAsync('git', args, { maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Materialize the custody `agents/` scope into the host credential-backup files
 * `provider.create`'s seed step reads (`~/.agentbox/<id>-credentials.json`). So a
 * PC `credentials push` (phase 2) is what logs hub-created boxes in — one code
 * path, no second credential list.
 */
async function seedHostBackupsFromCustody(custody: FsCustodyStore, log: (l: string) => void): Promise<void> {
  for (const spec of AGENT_SYNC_SPECS) {
    const custodyPath = `agents/${spec.id}/${spec.credential.boxRelPath}`;
    try {
      const found = await custody.get(custodyPath);
      if (!found) continue;
      await mkdir(dirname(spec.credential.hostBackup), { recursive: true });
      await writeFile(spec.credential.hostBackup, found.data, { mode: 0o600 });
      log(`seeded ${spec.id} credentials from custody`);
    } catch (err) {
      log(`seed ${spec.id} from custody failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Mirror a just-created box's minted SSH key material into custody
 * `boxes/<boxId>/ssh/` so phase 4's `hub pull` can fetch it. Only the VPS
 * backends (hetzner / digitalocean) mint a per-box keypair; the SDK backends
 * (e2b / vercel) don't, so this is a best-effort no-op for them.
 */
async function mirrorBoxSshToCustody(
  custody: FsCustodyStore,
  boxId: string,
  provider: string,
  sandboxId: string | undefined,
  log: (l: string) => void,
): Promise<void> {
  if (!sandboxId || (provider !== 'hetzner' && provider !== 'digitalocean')) return;
  const sshDir = defaultBoxSshDir(sandboxId, provider);
  try {
    const files = await readdir(sshDir, { withFileTypes: true }).catch(() => []);
    const { readFile } = await import('node:fs/promises');
    for (const f of files) {
      if (!f.isFile()) continue;
      const data = await readFile(join(sshDir, f.name));
      await custody.put(`boxes/${boxId}/ssh/${f.name}`, data);
    }
    if (files.length > 0) log(`mirrored ${provider} box ${boxId} ssh keys to custody`);
  } catch (err) {
    log(`ssh-mirror ${boxId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface HubWorkerOptions {
  store: Store;
  log: (line: string) => void;
  /** Public hub URL a created box registers against (control-plane topology). */
  publicUrl?: string;
  /** Admin PC egress CIDR added to a hetzner box's firewall (dual-IP reach). */
  adminCidr?: string;
  /** Poll cadence. Default 5s. */
  intervalMs?: number;
  /**
   * Test seam: return a fake box id instead of touching a real cloud, so the
   * in-box docker smoke can drive the queue end-to-end offline. On when
   * `AGENTBOX_HUB_WORKER_MOCK=1`.
   */
  mockCreate?: boolean;
}

export interface HubWorkerHandle {
  stop: () => Promise<void>;
}

/** Build the worker's `CreateBoxFn` (exported for the offline smoke/tests). */
export function makeHubCreateBox(opts: HubWorkerOptions): CreateBoxFn {
  const { log } = opts;
  const custody = new FsCustodyStore();

  if (opts.mockCreate) {
    // Offline path: skip lease/clone/provider entirely, return a synthetic id.
    return (request, jobId) => {
      log(`[mock] created box for job ${jobId} (${request.provider} ${request.repoUrl})`);
      return Promise.resolve({ boxId: `mock-${jobId.slice(0, 8)}` });
    };
  }

  const appCfg = loadGitHubAppConfig();
  if (!appCfg) throw new Error('no GitHub App configured (AGENTBOX_GITHUB_APP_* / control-plane.env)');
  const leaser = new GitHubAppLeaser(appCfg);
  const extraInboundCidrs = opts.adminCidr ? [opts.adminCidr] : undefined;

  return makeControlPlaneCreateBox({
    leaseRemoteUrl: async (repoUrl) => {
      const { path } = parseGitRemote(repoUrl);
      const [owner, repo] = path.replace(/\.git$/, '').split('/');
      if (!owner || !repo) throw new Error(`cannot derive owner/repo from ${repoUrl}`);
      const { token } = await leaser.leaseRepoToken(owner, repo);
      return toAuthedHttpsUrl(repoUrl, token);
    },
    cloneRepo: async (authedUrl, repoUrl, dest, branch) => {
      await runGit(branch ? ['clone', '--branch', branch, authedUrl, dest] : ['clone', authedUrl, dest]);
      await runGit(['-C', dest, 'remote', 'set-url', 'origin', repoUrl]);
    },
    createBox: async ({ workspacePath, name, provider, onLog }) => {
      if (!isProviderKind(provider)) throw new Error(`unknown provider ${provider}`);
      const mod = (await IMPORTERS[provider]()).providerModule;
      if (mod.ensureCredentials) await mod.ensureCredentials();
      // Seed agent creds from custody just before create, so provider.create's
      // seed step reads a logged-in host backup.
      await seedHostBackupsFromCustody(custody, log);
      const created = await mod.provider.create({
        workspacePath,
        name,
        projectRoot: workspacePath,
        // Register the box on THIS hub (control-plane topology) so the phone UI
        // sees it and approvals route back here.
        controlPlaneUrl: opts.publicUrl,
        ...(extraInboundCidrs ? { providerOptions: { extraInboundCidrs } } : {}),
        onLog,
      });
      await mirrorBoxSshToCustody(
        custody,
        created.record.id,
        provider,
        created.record.cloud?.sandboxId,
        log,
      );
      return { id: created.record.id };
    },
    tmpDir: (jobId) => join(tmpdir(), `agentbox-hub-worker-${jobId}`),
    cleanup: (dir) => rm(dir, { recursive: true, force: true }),
    log,
  });
}

/** Start the resident worker loop. Returns a handle to stop it on shutdown. */
export function startHubWorker(opts: HubWorkerOptions): HubWorkerHandle {
  const { store, log } = opts;
  if (!store.claimNextCreateJob || !store.completeCreateJob) {
    log('worker: store has no create-job queue; not starting');
    return { stop: () => Promise.resolve() };
  }
  const createBox = makeHubCreateBox(opts);
  const workerId = `hub-${hostname()}`;
  const intervalMs = opts.intervalMs ?? 5000;
  let ticking = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const n = await drainCreateJobs(store, createBox, workerId);
      if (n > 0) log(`worker: processed ${String(n)} create job(s)`);
    } catch (err) {
      log(`worker: tick error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = tick();
  }, intervalMs);
  timer.unref();
  log(`worker: draining create jobs as ${workerId}`);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight.catch(() => {});
    },
  };
}
