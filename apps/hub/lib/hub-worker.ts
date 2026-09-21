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
import { appendFileSync, mkdirSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseProviderSpec } from '@agentbox/config';
import {
  cloneRepoWithLfs,
  drainCreateJobs,
  FsCustodyStore,
  GitHubAppLeaser,
  loadGitHubAppConfig,
  makeControlPlaneCreateBox,
  parseGitRemote,
  queueLogPath,
  QUEUE_LOGS_DIR,
  toAuthedHttpsUrl,
  toHttpsUrl,
  type CreateBoxFn,
  type Store,
} from '@agentbox/relay/control-plane';
// The full library entry: the timeline sink is host-side state, not part of the
// lean control-plane surface the Next app imports.
import { timelineSink } from '@agentbox/relay';
import {
  AGENT_SYNC_SPECS,
  boxNameBasisFromOriginUrl,
  boxSshDirForProvider,
  projectSlugFromOriginUrl,
  readCredentialBackup,
  shouldAcceptCredentialUpdate,
  writeCredentialBackup,
} from '@agentbox/sandbox-core';
import {
  applyProjectSeed,
  startDetachedCloudAgent,
  type MaterializedCarryEntry,
} from '@agentbox/sandbox-cloud';
import { resolveAgentLauncher, toQueueKind, type ResolvedCarryEntry } from '@agentbox/core';
import { hydratePreparedFromCustody } from './prepared-hydrate.js';
import { HUB_WORKER_CLONE_PREFIX } from './boxes/project-key.js';
import { createStartsSession, resolveCreateAgentSpec } from './boxes/create-agent.js';
import { isRuntimeProviderName, loadProviderModuleByName } from './provider-importers.js';
import type { QueueAgentKind } from '@agentbox/core';

const execFileAsync = promisify(execFile);

async function runGit(
  args: string[],
  env?: Record<string, string>,
  timeoutMs?: number,
): Promise<void> {
  await execFileAsync('git', args, {
    maxBuffer: 64 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });
}

/**
 * Materialize the custody `agents/` scope into the host credential-backup files
 * `provider.create`'s seed step reads (`~/.agentbox/<id>-credentials.json`). So a
 * PC `credentials push` (phase 2) is what logs hub-created boxes in — one code
 * path, no second credential list.
 */
export async function seedHostBackupsFromCustody(
  custody: Pick<FsCustodyStore, 'get'>,
  log: (l: string) => void,
): Promise<void> {
  for (const spec of AGENT_SYNC_SPECS) {
    // Nothing was ever uploaded for an agent that declares no credential.
    if (!spec.credential) continue;
    const custodyPath = `agents/${spec.id}/${spec.credential.boxRelPath}`;
    try {
      const found = await custody.get(custodyPath);
      if (!found) continue;
      const incoming = found.data.toString('utf8');
      // NEVER downgrade. This used to overwrite unconditionally, which is how a
      // box came up logged out: a box's refreshed token had just landed in the
      // host backup (via CredentialsFanout), and the next create replaced it with
      // custody's hours-old copy. Claude's OAuth refresh ROTATES the refresh
      // token, so an older blob isn't merely expired — it is dead, and the box
      // cannot recover from it. Same newest-wins rule the fanout applies.
      const existing = await readCredentialBackup(spec.id);
      const verdict = shouldAcceptCredentialUpdate(spec.id, incoming, existing);
      if (!verdict.accept) {
        log(`kept the local ${spec.id} credentials (custody copy ${verdict.reason})`);
        continue;
      }
      await writeCredentialBackup(spec.id, incoming);
      log(`seeded ${spec.id} credentials from custody (${verdict.reason})`);
    } catch (err) {
      log(
        `seed ${spec.id} from custody failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Mirror a just-created box's minted SSH key material into custody
 * `boxes/<sandboxId>/ssh/` so phase 4's `hub pull` can fetch it. Keyed by the
 * provider sandbox id (NOT the box id) because that is the id the on-disk ssh
 * dir and the `hub pull` destination use, so a download lands the bytes at the
 * exact path attach/cp read. Only the VPS backends (hetzner / digitalocean) mint
 * a per-box keypair — `boxSshDirForProvider` returns `null` for the SDK backends
 * (e2b / vercel), so this is a no-op for them. It also fixes the phase-3 bug
 * where hetzner's un-namespaced dir was read with a namespace, mirroring nothing.
 */
async function mirrorBoxSshToCustody(
  custody: FsCustodyStore,
  provider: string,
  sandboxId: string | undefined,
  log: (l: string) => void,
): Promise<void> {
  if (!sandboxId) return;
  const sshDir = boxSshDirForProvider(provider, sandboxId);
  if (!sshDir) return;
  try {
    const files = await readdir(sshDir, { withFileTypes: true }).catch(() => []);
    const { readFile } = await import('node:fs/promises');
    for (const f of files) {
      if (!f.isFile()) continue;
      const data = await readFile(join(sshDir, f.name));
      await custody.put(`boxes/${sandboxId}/ssh/${f.name}`, data);
    }
    if (files.length > 0) log(`mirrored ${provider} box ${sandboxId} ssh keys to custody`);
  } catch (err) {
    log(`ssh-mirror ${sandboxId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface HubWorkerOptions {
  store: Store;
  log: (line: string) => void;
  /** Public hub URL a created box registers against (control-plane topology). */
  publicUrl?: string;
  /**
   * How THIS hub authenticates git for the boxes it builds (`hub.gitAuth`).
   * Its own config, never the client's — the client's hub is a different
   * machine with a different App.
   */
  gitAuth?: 'gh' | 'app';
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

/**
 * Overlay a project's custody seed material onto a fresh clone: the untracked
 * files and env/secrets a PC pushed, which no clone can carry.
 *
 * Conflict rule: **the clone wins**. A file that was untracked when the seed was
 * captured but has since been committed exists in both; the repo's version is
 * the current truth, and restoring a months-old copy over it would silently
 * revert work. Extraction uses `tar --keep-old-files` so existing paths are left
 * alone, and env files are only written where nothing is already there.
 *
 * We read the custody store directly rather than over HTTP — the hub IS the
 * custody host.
 */
async function applySeedFromCustody(
  custody: FsCustodyStore,
  repoUrl: string,
  dest: string,
  log: (l: string) => void,
): Promise<{
  files: number;
  capturedAt?: string;
  repoHeadSha?: string;
  carry?: MaterializedCarryEntry[];
} | null> {
  const slug = projectSlugFromOriginUrl(repoUrl);
  if (!slug) return null;
  // The hub IS the custody host, so it reads the store directly rather than
  // over HTTP. The overlay itself is shared with the laptop worker.
  return applyProjectSeed({
    source: {
      get: async (rel) => (await custody.get(`projects/${slug}/seed/${rel}`))?.data ?? null,
    },
    dest,
    // `carry:` payloads land BESIDE the checkout, not inside it: a carry entry's
    // destination is an arbitrary in-box path, so the provider copies them from
    // here rather than the workspace overlaying them. Removed with the clone.
    carryStageDir: `${dest}.carry`,
    log,
  });
}

// `hydratePreparedFromCustody` now lives in ./prepared-hydrate.js so the
// settings/freshness path (hub-backend.ts) can reuse the exact adoption logic.

export interface HubWorkerHandle {
  stop: () => Promise<void>;
}

/**
 * Per-job logger: the worker-wide log (so the container log still shows progress)
 * plus an append to `~/.agentbox/logs/queue-<jobId>.log`. The web UI's create modal
 * streams that file — it is the only progress a hub-driven create surfaces, and
 * without it the modal sits blank for the minutes a cloud create takes.
 * Synchronous writes: `log` is a fire-and-forget callback with no way to await.
 */
function makeJobLogger(log: (line: string) => void): (jobId: string) => (line: string) => void {
  return (jobId) => (line) => {
    log(`[${jobId.slice(0, 8)}] ${line}`);
    try {
      mkdirSync(QUEUE_LOGS_DIR, { recursive: true });
      appendFileSync(queueLogPath(jobId), `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* the log file is a convenience; never fail a create over it */
    }
  };
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

  const extraInboundCidrs = opts.adminCidr ? [opts.adminCidr] : undefined;

  return makeControlPlaneCreateBox({
    /**
     * Resolve a clone URL the worker can authenticate with.
     *
     * Resolved PER JOB, not at construction. This used to `throw` here when no
     * GitHub App was configured — but `startHubWorker` builds this eagerly at
     * boot, so a hub without an App died before it could serve the UI you'd use
     * to configure one. In `hub.gitAuth=gh` mode that's the normal day-one
     * state. Now a missing credential fails one job with an actionable message
     * and the queue keeps draining.
     *
     * With no App, hand back the URL over HTTPS: the hub authenticates via
     * git's credential helper (`gh auth setup-git` + `GH_TOKEN`), the same way
     * it authenticates the pushes it makes on a box's behalf. Normalizing the
     * scheme is load-bearing, not cosmetic — a `git@github.com:` origin (what
     * the PC registered, because that is how the user cloned it) would take the
     * ssh transport, which has no key and no `known_hosts` here and so dies at
     * host-key verification before the helper is ever consulted.
     */
    leaseRemoteUrl: async (repoUrl) => {
      const appCfg = loadGitHubAppConfig();
      if (!appCfg) return toHttpsUrl(repoUrl);
      const { path } = parseGitRemote(repoUrl);
      const [owner, repo] = path.replace(/\.git$/, '').split('/');
      if (!owner || !repo) throw new Error(`cannot derive owner/repo from ${repoUrl}`);
      const { token } = await new GitHubAppLeaser(appCfg).leaseRepoToken(owner, repo);
      return toAuthedHttpsUrl(repoUrl, token);
    },
    // The third argument is what `origin` is scrubbed back to once the leased
    // token has been used, and it becomes the box's registered `originUrl` —
    // which on a control box IS the push target (`host-actions.ts` trusts only
    // the registered origin when there is no host checkout). Leave it on HTTPS
    // for the same reason the clone URL is: the hub can authenticate that, and
    // cannot authenticate ssh.
    cloneRepo: (authedUrl, repoUrl, dest, branch) =>
      cloneRepoWithLfs(runGit, authedUrl, toHttpsUrl(repoUrl), dest, branch, log),
    createBox: async ({
      workspacePath,
      name,
      repoUrl,
      carry,
      provider,
      agent,
      prompt,
      agentArgs,
      startAgent,
      opts: createOpts,
      onLog,
    }) => {
      // A `docker:<alias>` / `remote-docker:<alias>` request names an engine, not
      // a provider: the provider is remote-docker and the alias is threaded to it
      // as a provider option (the CLI does the same, via buildProviderOptions).
      const { name: providerName, remoteHost } = parseProviderSpec(provider);
      if (!isRuntimeProviderName(providerName)) throw new Error(`unknown provider ${provider}`);
      if (remoteHost) {
        const rd = await import('@agentbox/sandbox-remote-docker');
        if (!rd.getHostAlias(remoteHost)) {
          throw new Error(
            `unknown remote-docker host '${remoteHost}' on this hub — share it from the machine that owns it (\`agentbox remote-docker share ${remoteHost}\`)`,
          );
        }
      }
      // Resolved BEFORE the provider is loaded, so an unknown agent fails the
      // job here rather than after a box has been built for it.
      const agentSpec = resolveCreateAgentSpec(agent);
      const mod = await loadProviderModuleByName(providerName);
      if (mod.ensureCredentials) await mod.ensureCredentials();
      // Seed agent creds from custody just before create, so provider.create's
      // seed step reads a logged-in host backup.
      await seedHostBackupsFromCustody(custody, log);
      // Likewise the base image: the deploy seeds `prepared/<provider>.json`
      // into custody, but the provider's baked-or-not gate only reads local
      // prepared-state — so without this a fresh control box refuses to create.
      await hydratePreparedFromCustody(custody, providerName, mod.provider, log);
      // `workspacePath` is the per-job clone deleted on the way out, so leaving
      // the provider to derive a default name from it produces
      // `agentbox-hub-worker-<uuid>-<id>` — a box named after a directory that no
      // longer exists, telling nobody which project it is. Name it after the repo.
      const nameBasis = boxNameBasisFromOriginUrl(repoUrl);
      const created = await mod.provider.create({
        workspacePath,
        name,
        ...(nameBasis ? { nameBasis } : {}),
        // Approved `carry:` entries, staged from custody beside the clone. The
        // provider's own applyCarry takes it from here — placeholder rendering
        // included, now with a real box context — so a hub-built box gets the
        // same files a locally-built one would.
        ...(carry?.length ? { carry: carry as ResolvedCarryEntry[] } : {}),
        projectRoot: workspacePath,
        // Registered on the plane so an adopting PC relaunches the right agent.
        agent: agentSpec?.id,
        // Register the box on THIS hub (control-plane topology) so the phone UI
        // sees it and approvals route back here.
        controlPlaneUrl: opts.publicUrl,
        // Box-shaping flags the CLI resolved. Applied so a control-box create
        // honors them instead of silently building with defaults — the machine
        // that asked is the only one with the project's config, so anything
        // missing here is the provider's default, not the project's choice.
        ...(createOpts?.snapshot ? { checkpointRef: createOpts.snapshot } : {}),
        ...(createOpts?.useBranch ? { useBranch: createOpts.useBranch } : {}),
        ...(createOpts?.imageRegistry ? { imageRegistry: createOpts.imageRegistry } : {}),
        // This control box's own setting, never the client's: it names the
        // GitHub App that leases tokens HERE.
        hubGitAuth: opts.gitAuth,
        ...(createOpts?.image ? { image: createOpts.image } : {}),
        ...(createOpts?.withPlaywright !== undefined
          ? { withPlaywright: createOpts.withPlaywright }
          : {}),
        ...(createOpts?.withEnv !== undefined ? { withEnv: createOpts.withEnv } : {}),
        ...(createOpts?.vnc !== undefined ? { vnc: { enabled: createOpts.vnc } } : {}),
        ...(createOpts?.persistent !== undefined ? { persistent: createOpts.persistent } : {}),
        ...(createOpts?.bundleDepth !== undefined ? { bundleDepth: createOpts.bundleDepth } : {}),
        ...(createOpts?.build ? { allowPull: false } : {}),
        ...(createOpts?.credentialSync !== undefined
          ? { credentialSync: createOpts.credentialSync }
          : {}),
        // Model-auth sources the CLI already resolved. Only the ids travelled;
        // the login itself was materialized above by seedHostBackupsFromCustody,
        // and `resolveHostCredentialFile` prefers that backup over this VPS's
        // own home — so the box gets the USER's login, not the control box's.
        ...(createOpts?.borrowCredentials?.length
          ? { borrowCredentials: createOpts.borrowCredentials }
          : {}),
        // Everything provider-shaped comes from the machine that HAS the project
        // config; this box has neither the checkout nor
        // `~/.agentbox/projects/<hash>`, so resolving any of it here would only
        // ever yield the provider's default. The hub's own two keys go on top:
        // `extraInboundCidrs` opens a firewall and is never taken from a client.
        ...(() => {
          const fromClient = {
            ...(createOpts?.providerOptions ?? {}),
            ...(createOpts?.size ? { size: createOpts.size } : {}),
            ...(createOpts?.location ? { location: createOpts.location } : {}),
            ...(createOpts?.inbound ? { inbound: createOpts.inbound } : {}),
          };
          const providerOptions = {
            ...fromClient,
            ...(extraInboundCidrs ? { extraInboundCidrs } : {}),
            ...(remoteHost ? { remoteHost } : {}),
          };
          return Object.keys(providerOptions).length > 0 ? { providerOptions } : {};
        })(),
        onLog,
      });
      await mirrorBoxSshToCustody(custody, providerName, created.record.cloud?.sandboxId, log);

      // Background `-i`: a seed prompt means run the agent fully on the control
      // box (create + start detached), so the laptop can be off from submit on.
      // A cold create (create --via-hub / foreground) has no prompt — the PC
      // attaches those. `startAgent` is the third case: a hub web-UI create, which
      // wants a live session but has no prompt to imply one. Creds were seeded
      // above (seedHostBackupsFromCustody), so the box is logged in; a
      // not-logged-in box surfaces as an actionable error from
      // verifyDetachedSession, which we return so the job fails WITH the box id
      // (box preserved for adopt/attach + re-login).
      // A SERVICE agent gets a box and a registered agent but NO session: its
      // daemon is ctl's job, run from units synthesized in-box off the
      // `agents.list` payload, so there is nothing to pre-start here.
      const boxAgent = createStartsSession(agentSpec) ? agentSpec?.id : undefined;
      const seedPrompt = prompt && prompt.length > 0 ? prompt : undefined;
      if (boxAgent && (seedPrompt || startAgent)) {
        const kind: QueueAgentKind = toQueueKind(boxAgent);
        const extraArgs = resolveAgentLauncher(kind).buildArgs(seedPrompt ?? '', agentArgs ?? []);
        log(
          `starting ${boxAgent} in ${created.record.name}${seedPrompt ? ' with the seed prompt' : ''}`,
        );
        try {
          await startDetachedCloudAgent({
            provider: mod.provider,
            box: created.record,
            binary: boxAgent,
            // The submitter's own `<agent>.sessionName`, when they set one: a
            // box whose session is named something else is a box their attach
            // cannot find.
            sessionName: createOpts?.sessionName?.trim() || boxAgent,
            extraArgs,
          });
          log(`${boxAgent} session is running in ${created.record.name}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`agent start failed (box was created): ${msg}`);
          return { id: created.record.id, agentStartError: msg };
        }
      }
      return { id: created.record.id };
    },
    fetchSeedMaterial: (repoUrl, dest) => applySeedFromCustody(custody, repoUrl, dest, log),
    tmpDir: (jobId) => join(tmpdir(), `${HUB_WORKER_CLONE_PREFIX}${jobId}`),
    cleanup: async (dir) => {
      // The carry staging dir is a sibling of the clone (see applySeedFromCustody),
      // so it needs its own sweep or an approved payload lingers in $TMPDIR.
      await rm(dir, { recursive: true, force: true });
      await rm(`${dir}.carry`, { recursive: true, force: true });
    },
    log,
    logFor: makeJobLogger(log),
  });
}

/**
 * `box.ready` / `box.failed` for a create job the worker just finished, in the
 * workspace the job's repo belongs to. The control box holds no checkout, so the
 * repo is the join; the job-scoped key keeps a re-reported completion to one row.
 *
 * Best-effort: a log miss must never change a job's status.
 */
export async function recordCreateJobRowTimeline(
  store: Store,
  id: string,
  status: 'done' | 'failed',
  result: { boxId?: string; error?: string },
): Promise<void> {
  try {
    const job = await store.getCreateJob?.(id);
    if (!job) return;
    const ws = await timelineSink().workspaceFor({ originUrl: job.request.repoUrl });
    if (!ws) return;
    const reg = result.boxId ? await store.getBox(result.boxId).catch(() => undefined) : undefined;
    const ready = status === 'done';
    const name = reg?.name ?? job.request.name;
    const branch = reg?.worktrees?.[0]?.branch;
    await timelineSink().record(ws.id, {
      type: ready ? 'box.ready' : 'box.failed',
      actor: 'hub',
      key: `job:${id}:${ready ? 'ready' : 'failed'}`,
      ...(result.boxId ? { boxId: result.boxId } : {}),
      ...(name ? { boxName: name } : {}),
      ...(job.request.agent && job.request.agent !== 'none' ? { agent: job.request.agent } : {}),
      ...(branch ? { branch } : {}),
      ...(job.request.branch ? { base: job.request.branch } : {}),
      ...(!ready && result.error ? { text: result.error.slice(0, 500) } : {}),
    });
  } catch {
    /* best-effort */
  }
}

/**
 * The store the drain loop writes through: identical, except that completing a
 * create job also logs it. A proxy rather than a copy — a `Store` is a class
 * instance whose methods live on its prototype, and spreading one loses them.
 */
function storeWithCreateTimeline(store: Store): Store {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop !== 'completeCreateJob') {
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const complete = target.completeCreateJob;
      if (!complete) return undefined;
      return async (
        id: string,
        status: 'done' | 'failed',
        result: { boxId?: string; error?: string },
      ): Promise<void> => {
        await complete.call(target, id, status, result);
        await recordCreateJobRowTimeline(target, id, status, result);
      };
    },
  });
}

/** Start the resident worker loop. Returns a handle to stop it on shutdown. */
export function startHubWorker(opts: HubWorkerOptions): HubWorkerHandle {
  const { log } = opts;
  const store = storeWithCreateTimeline(opts.store);
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
