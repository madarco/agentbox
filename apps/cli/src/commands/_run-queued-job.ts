/**
 * Internal worker the relay's queue loop spawns as a detached child to run a
 * queued `-i` job. Hidden from `--help`. Reads a queue manifest by id, then
 * runs the same create + session-start codepath the foreground claude / codex
 * / opencode commands run in non-`-i` mode, then exits when tmux is up.
 * **Never** attaches — the in-box session keeps running for the user to
 * re-attach later.
 *
 * Docker bakes the seeded prompt straight into `tmux new-session` at create
 * time (`runDockerJob`). Cloud providers (daytona/hetzner/vercel) create the
 * box, then pre-start a detached tmux session seeded with the same prompt via
 * `cloudAgentStartDetached` → `buildAttach({ detached: true })` (`runCloudJob`).
 */

import { Command } from 'commander';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  findProjectRoot,
  loadEffectiveConfig,
  resolveDefaultCheckpoint,
  type UserConfig,
} from '@agentbox/config';
import {
  clearRelayPrompt,
  createBox,
  DEFAULT_BOX_IMAGE,
  detectEngine,
  ensureImage,
  hostBackupHasCredentials,
  raiseRelayPrompt,
  rebuildPluginNativeDeps,
  recordLastAgent,
  SHARED_CLAUDE_VOLUME,
  startClaudeSession,
  startCodexSession,
  startOpencodeSession,
  ensureCodexInstalled,
  ensureOpencodeInstalled,
  volumeClaudeCredentials,
} from '@agentbox/sandbox-docker';
import { isNotAuthenticatedError, type NotAuthenticatedError } from '@agentbox/sandbox-cloud';
import {
  readJob,
  takeQueueLoginCode,
  writeJob,
  type QueueAgentKind,
  type QueueJob,
  type QueueJobLogin,
} from '@agentbox/relay';
import { toSyncKind } from '@agentbox/core';
import { resolveClaudeAuth } from '../auth.js';
import { claudeCredStatus } from '../lib/queue/assert-creds.js';
import { runClaudeLogin } from '../lib/claude-login-run.js';
import { cloudSizingProviderOptions } from '../lib/cloud-sizing.js';
import { resolveLimits } from '../limits.js';
import { openCommandLog } from '../lib/log-file.js';
import { buildPromptArgs } from '../lib/queue/build-prompt-args.js';
import { buildResyncWarning, prependResyncWarning } from '../lib/resync-warning.js';
import { applyClaudeSkipPermissions, applyCodexSkipPermissions } from '../lib/skip-permissions.js';
import { providerForCreate } from '../provider/registry.js';
import { autoWriteSshConfig } from '@agentbox/sandbox-core';
import { cloudAgentStartDetached } from './_cloud-attach.js';
import { spawnQueuedOpenTerminal } from '../terminal/queue-open.js';
import { resolvePortlessNonInteractive } from '../portless-prompt.js';
import { buildSetupInitialPrompt } from '../wizard.js';

/**
 * Seed the setup-wizard prompt when the hub requested it (`job.setupWizard`):
 * the box's first agent turn asks the agent to explore the workspace and
 * generate `agentbox.yaml`. Mirrors what the CLI wizard does for a fresh,
 * unconfigured project — but here it's decided on the host (the hub knew the
 * project had no `agentbox.yaml` + no default snapshot) and carried on the job.
 * A user-typed prompt still runs, after the setup guidance.
 */
async function applySetupWizardPrompt(job: QueueJob, workspace: string, basePrompt: string): Promise<string> {
  if (!job.setupWizard) return basePrompt;
  const hasYaml = await stat(join(workspace, 'agentbox.yaml'))
    .then(() => true)
    .catch(() => false);
  const setup = buildSetupInitialPrompt(workspace, hasYaml);
  const rest = basePrompt.trim();
  return rest ? `${setup}\n\nThen, once the setup is done: ${rest}` : setup;
}

/** Merge a login sub-state patch onto the on-disk manifest, preserving the rest. */
async function patchJobLogin(id: string, patch: Partial<QueueJobLogin>): Promise<void> {
  const j = await readJob(id);
  if (!j) return;
  const cur: QueueJobLogin = j.login ?? { required: true, phase: 'starting' };
  await writeJob({ ...j, login: { ...cur, ...patch } });
}

/**
 * True when the box needs a fresh Claude browser login before it can be created.
 * A forwarded host-env token short-circuits (it's mounted straight in). Cloud
 * rides the host backup (login when missing or the cloud-only expiry fires);
 * docker boots from the shared volume and self-refreshes a present token in-box,
 * so it only needs login when neither the volume nor the host backup holds a
 * usable refresh token.
 */
async function needsClaudeLogin(image: string, isCloud: boolean): Promise<boolean> {
  const resolved = await resolveClaudeAuth(process.env);
  if (resolved.source !== 'none') return false;
  if (isCloud) return (await claudeCredStatus(process.env, true)) !== 'ok';
  const vol = await volumeClaudeCredentials(SHARED_CLAUDE_VOLUME, image);
  if (vol.hasRefreshToken) return false;
  return !(await hostBackupHasCredentials());
}

/**
 * Before creating a claude box, detect an expired/dead Claude login and, if so,
 * drive a browser re-login in a throwaway docker container. Surfaces the state
 * (phase/url/error) + verbatim transcript on the job manifest / create log so the
 * hub UI can show the flow and POST back the pasted code. Blocks (the job stays
 * `running`) until login completes; throws on failure so the job fails with the
 * reason. The login always writes the shared volume + host backup, which then
 * seeds/refreshes both docker (volume) and cloud (backup push) creates.
 */
async function ensureClaudeLoginFresh(args: {
  id: string;
  log: ReturnType<typeof openCommandLog>;
  image: string;
  isCloud: boolean;
}): Promise<void> {
  const { id, log, image, isCloud } = args;
  if (!(await needsClaudeLogin(image, isCloud))) return;

  log.write('claude login is expired or missing — starting browser re-login');
  await patchJobLogin(id, { required: true, phase: 'starting' });
  await ensureImage(image, { onProgress: (line) => log.write(line) });

  // Serialize ALL of our manifest writes through one chain so read-modify-write
  // patches (phase/url/error AND the code-clear below) can't interleave and lose
  // each other's updates. Log failures rather than swallow them.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (patch: Partial<QueueJobLogin>): void => {
    chain = chain
      .then(() => patchJobLogin(id, patch))
      .catch((err) => log.write(`login manifest write failed: ${err instanceof Error ? err.message : String(err)}`));
  };

  // Bridge the hub's login-code file (UI → worker) to the synchronous getCode the
  // login core polls: read+consume it off disk and hand it over once. This is a
  // separate channel from the manifest `login` (worker → UI), so the hub and the
  // worker never write the same object.
  // Poll the hub's code file; the newest paste always wins. We don't gate on a
  // buffered `pendingCode`, so a corrected paste supersedes an earlier one instead
  // of queueing behind it (takeQueueLoginCode deletes the file, so an empty read is
  // a cheap no-op).
  let pendingCode: string | null = null;
  const codeWatcher = setInterval(() => {
    void (async () => {
      const c = await takeQueueLoginCode(id);
      if (c) pendingCode = c;
    })();
  }, 500);

  // Abort the in-flight login promptly if the queue worker is stopped, instead of
  // leaving the login container running until the URL/code timeout.
  const abort = new AbortController();
  const onSignal = (): void => abort.abort();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, onSignal);

  try {
    const result = await runClaudeLogin({
      image,
      signal: abort.signal,
      writeRaw: (chunk) => log.raw(chunk),
      writeLog: (line) => log.write(line),
      onPhase: (phase, u) => {
        const patch: Partial<QueueJobLogin> = { phase };
        if (u?.url) patch.url = u.url;
        if (u?.error !== undefined) patch.error = u.error;
        if (u?.lastError !== undefined) patch.lastError = u.lastError;
        enqueue(patch);
      },
      getCode: () => {
        const c = pendingCode;
        pendingCode = null;
        return c;
      },
    });
    await chain;
    if (!result.ok) throw new Error(result.error ?? 'claude login failed');
    log.write('claude login refreshed');
  } finally {
    clearInterval(codeWatcher);
    for (const sig of ['SIGTERM', 'SIGINT'] as const) process.removeListener(sig, onSignal);
  }
}

export const runQueuedJobCommand = new Command('_run-queued-job')
  .description('internal: run a queued background agent job (do not invoke directly)')
  .argument('<id>', 'queue job id (from ~/.agentbox/queue/<id>.json)')
  .action(async (id: string) => {
    const log = openCommandLog(`queue-${id}`);
    log.write(`worker pid=${String(process.pid)} starting for job ${id}`);
    let job: QueueJob | null = null;
    try {
      job = await readJob(id);
      if (!job) {
        log.write(`FATAL: no manifest at id=${id}`);
        log.close();
        process.exit(64);
      }
      // The relay loop already flipped status to `running` and stamped its
      // pid; we don't double-stamp. If a future caller invokes this command
      // manually we still run, but the relay's accounting will be off — that
      // is the user's problem (and exactly why this command is hidden).

      // Run the create + session path, routed by provider. The worker records
      // boxId on the outer `job` the instant the box is created (via
      // onBoxCreated), so the catch block below preserves the box attribution
      // even if the session start throws afterwards.
      const onBoxCreated = (boxId: string): void => {
        if (job) job = { ...job, boxId };
      };
      if ((job.providerName || 'docker') === 'docker') {
        await runDockerJob(job, log, onBoxCreated);
      } else {
        await runCloudJob(job, log, onBoxCreated);
      }

      // Re-read to preserve any `login` sub-state a re-login wrote (the in-memory
      // `job` predates it); a bare replace would drop the terminal login phase.
      const persisted = await readJob(id);
      const done: QueueJob = {
        ...job,
        status: 'done',
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        login: persisted?.login,
      };
      await writeJob(done);
      log.write(`done`);
      log.close();
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      log.write(`FAIL: ${msg}`);
      if (job) {
        try {
          const persisted = await readJob(id);
          const failed: QueueJob = {
            ...job,
            status: 'failed',
            finishedAt: new Date().toISOString(),
            reason: err instanceof Error ? err.message : String(err),
            exitCode: 1,
            login: persisted?.login,
          };
          await writeJob(failed);
        } catch {
          /* best-effort */
        }
        // Rejected cloud credentials are fixable from the UI: kick a re-auth
        // flow so the hub/tray shows a "sign in" card next to the failed job.
        // Best-effort — the job's `reason` already carries the manual fix.
        if (isNotAuthenticatedError(err)) {
          await raiseCloudReauthPrompt(job, err, (line) => log.write(line));
        }
      }
      log.close();
      process.exit(1);
    }
  });

/**
 * A cloud provider rejected this job's credentials. Start the device-code
 * re-login (AWS-only today) and park an `open-link` approval on the host
 * relay so the hub/tray shows a clickable "sign in" card next to the failed
 * job. The worker stays alive until the login completes or AWS's device-code
 * window lapses (~10 min) — exiting earlier would kill the polling child the
 * URL points at. Best-effort at every step.
 */
async function raiseCloudReauthPrompt(
  job: QueueJob,
  err: NotAuthenticatedError,
  logLine: (line: string) => void,
): Promise<void> {
  if (err.provider !== 'aws') return;
  try {
    const { startAwsSsoDeviceLogin } = await import('@agentbox/sandbox-aws');
    const flow = await startAwsSsoDeviceLogin();
    if (!flow) return; // not an SSO profile / no aws CLI — job.reason is the guidance
    // No box exists for a failed create; the job id keys the hub's synthetic
    // error box, so the card lands next to it.
    const promptId = await raiseRelayPrompt({
      boxId: job.boxId ?? job.id,
      kind: 'open-link',
      message: `AWS session expired — sign in to re-authenticate (profile ${flow.profile})`,
      detail: flow.url,
      url: flow.url,
      userCode: flow.userCode,
      hostOpen: false,
    });
    logLine(`aws re-auth: waiting for sign-in at ${flow.url}`);
    const ok = await flow.done;
    logLine(`aws re-auth: ${ok ? 'completed — retry the job' : 'not completed'}`);
    if (promptId) await clearRelayPrompt(promptId);
  } catch (e) {
    logLine(`aws re-auth flow failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runDockerJob(
  job: QueueJob,
  log: ReturnType<typeof openCommandLog>,
  onBoxCreated: (boxId: string) => void,
): Promise<void> {
  const opts = job.createOpts;
  const cfg = await loadEffectiveConfig(opts.workspace, {
    cliOverrides: buildOverridesFromJob(job),
  });
  const projectRoot = (await findProjectRoot(opts.workspace)).root;
  const providerName = job.providerName || cfg.effective.box.provider || 'docker';
  const providerDefault = resolveDefaultCheckpoint(cfg.effective, providerName);
  const checkpointRef =
    opts.snapshot && opts.snapshot.length > 0
      ? opts.snapshot
      : providerDefault.length > 0
        ? providerDefault
        : undefined;

  const useSnapshot =
    opts.hostSnapshot === false
      ? false
      : opts.hostSnapshot === true
        ? true
        : (cfg.effective.box.hostSnapshot ?? false);

  // Auth resolution mirrors the foreground claude path; codex/opencode don't
  // need a host-env probe (they ride the in-box volume that login seeded). A
  // no-agent box ("just create") needs no agent auth or config at all.
  const resolved =
    !job.noAgent && job.agent === 'claude-code' ? await resolveClaudeAuth(process.env) : null;

  // browser.default = 'playwright' | 'both' implies installing playwright
  // even if box.withPlaywright wasn't explicitly set.
  const withPlaywright =
    cfg.effective.box.withPlaywright || cfg.effective.browser.default !== 'agent-browser';

  // Re-login in a browser if the box's Claude credentials are dead (surfaced on
  // the job so the hub UI can drive it), before we create the box on them.
  if (!job.noAgent && job.agent === 'claude-code') {
    await ensureClaudeLoginFresh({ id: job.id, log, image: cfg.effective.box.image, isCloud: false });
  }

  // Background jobs (incl. hub / tray-app created boxes) can't negotiate
  // Portless interactively. An explicit --portless/--no-portless on the job
  // wins; otherwise resolve non-interactively — honoring a persisted config
  // opt-in, and, on Docker Desktop, adopting an already-running proxy so the
  // very first box started from the tray app gets its <name>.localhost alias
  // (previously it only worked after opting in once from a real terminal).
  const portlessEnabled =
    opts.portless ??
    (await resolvePortlessNonInteractive({
      engine: await detectEngine(),
      enabled: cfg.effective.portless.enabled,
      cwd: opts.workspace,
    }));

  log.write(`creating box for agent=${job.noAgent ? 'none' : job.agent}`);
  const result = await createBox({
    workspacePath: opts.workspace,
    name: opts.name && opts.name.length > 0 ? opts.name : undefined,
    // Base ref the box's per-box branch forks from (hub `--from-branch`); absent → HEAD.
    fromBranch: opts.fromBranch,
    useSnapshot,
    checkpointRef,
    image: cfg.effective.box.image,
    claudeConfig:
      !job.noAgent && job.agent === 'claude-code'
        ? { isolate: cfg.effective.box.isolateClaudeConfig }
        : undefined,
    codexConfig:
      !job.noAgent && job.agent === 'codex' ? { isolate: cfg.effective.box.isolateCodexConfig } : undefined,
    opencodeConfig:
      !job.noAgent && job.agent === 'opencode'
        ? { isolate: cfg.effective.box.isolateOpencodeConfig }
        : undefined,
    claudeEnv: resolved?.env,
    withPlaywright,
    withEnv: cfg.effective.box.withEnv,
    vnc: { enabled: cfg.effective.box.vnc },
    docker: { sharedCache: cfg.effective.box.dockerCacheShared },
    portless: portlessEnabled,
    portlessStateDir: cfg.effective.portless.stateDir || undefined,
    resyncOnStart: opts.resync,
    limits: resolveLimits(cfg.effective.box, opts),
    // carry: entries the submitter resolved + approved on the host; applied here
    // at box-create time (the worker runs on the host, so it can read the files).
    carry: opts.carry,
    projectRoot,
    onLog: (line) => log.write(line),
  });
  log.write(`box created: ${result.record.container}`);

  // Record the box id on the manifest (and propagate it to the caller) so the
  // relay's working-agent counter can join this running job to its live box
  // status, and stop counting the in-flight startup slot once the box has
  // registered. Written before the session starts so a crash mid-launch is
  // still attributable to a box.
  onBoxCreated(result.record.id);
  if (!job.noAgent) await recordLastAgent(result.record.id, toSyncKind(job.agent)).catch(() => {});
  // Preserve any `login` sub-state a re-login wrote to the manifest: the in-memory
  // `job` predates it, so a bare replace would wipe it mid-stream and the hub could
  // lose the OAuth phase/url or leave the create modal stuck on "Login required".
  const persisted = await readJob(job.id);
  await writeJob({ ...job, boxId: result.record.id, login: persisted?.login });

  // "Just create the box" (like `agentbox create`): the box is up with its ctl
  // supervisor running; skip the agent session entirely. The user attaches later
  // (agentbox shell / claude attach). No prompt, no terminal open.
  if (job.noAgent) {
    log.write('no-agent box created; skipping agent session');
    return;
  }

  // On-create resync conflicts (checkpoint-restore path): prepend the warning to
  // the queued prompt so the background agent opens on it.
  const resyncWarning = result.resync ? buildResyncWarning(result.resync) : null;
  if (resyncWarning) log.write(resyncWarning);
  const seeded = await applySetupWizardPrompt(job, opts.workspace, job.prompt);
  const prompt = prependResyncWarning(resyncWarning, seeded);
  const promptedArgs = buildPromptArgs(job.agent, prompt, job.agentArgs);

  if (job.agent === 'claude-code') {
    log.write(`checking plugin native deps`);
    await rebuildPluginNativeDeps(result.record.container, {
      volume: result.record.claudeConfigVolume ?? SHARED_CLAUDE_VOLUME,
      onProgress: (line) => log.write(line),
    });
    log.write(`starting claude session`);
    await startClaudeSession({
      container: result.record.container,
      claudeArgs: applyClaudeSkipPermissions(promptedArgs, cfg.effective),
      sessionName: cfg.effective.claude.sessionName,
      boxName: result.record.name,
    });
  } else if (job.agent === 'codex') {
    log.write(`checking codex`);
    await ensureCodexInstalled(result.record.container, {
      onProgress: (line) => log.write(line),
    });
    log.write(`starting codex session`);
    await startCodexSession({
      container: result.record.container,
      codexArgs: applyCodexSkipPermissions(promptedArgs, cfg.effective),
      sessionName: cfg.effective.codex.sessionName,
    });
  } else if (job.agent === 'opencode') {
    log.write(`checking opencode`);
    await ensureOpencodeInstalled(result.record.container, {
      onProgress: (line) => log.write(line),
    });
    log.write(`starting opencode session`);
    await startOpencodeSession({
      container: result.record.container,
      opencodeArgs: promptedArgs,
      sessionName: cfg.effective.opencode.sessionName,
    });
  } else {
    throw new Error(`unknown agent kind: ${String(job.agent satisfies QueueAgentKind)}`);
  }

  await maybeOpenQueuedTerminal(job, result.record.name, log);
}

/**
 * `queue.openIn`: open a fresh host terminal attached to the just-ready box.
 * Best-effort — a failure here never fails the job (the box is up and the user
 * can still attach manually). The targeting context was captured on the
 * submitting host at submit time; we re-invoke the CLI's own `attach` inline in
 * the new pane.
 */
async function maybeOpenQueuedTerminal(
  job: QueueJob,
  boxName: string,
  log: ReturnType<typeof openCommandLog>,
): Promise<void> {
  const ctx = job.openTerminal;
  if (!ctx) return;
  const cliEntry = process.env['AGENTBOX_CLI_ENTRY'];
  if (!cliEntry) {
    log.write('queue.openIn: AGENTBOX_CLI_ENTRY unset; cannot open terminal');
    return;
  }
  const argv = [
    process.execPath,
    cliEntry,
    toSyncKind(job.agent),
    'attach',
    boxName,
    '--attach-in',
    'same',
  ];
  try {
    const r = await spawnQueuedOpenTerminal(ctx, argv, boxName);
    log.write(
      r.launched ? `queue.openIn: ${r.note}` : `queue.openIn: open failed: ${r.error ?? ''}`,
    );
  } catch (err) {
    log.write(`queue.openIn: open threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Cloud (daytona/hetzner/vercel) variant of the queue worker. Mirrors the
 * foreground cloud-create path (`cloudAgentCreate`): `provider.create` does the
 * credential-volume seed, git-bundle workspace seed, and ctl daemon. We then
 * pre-start a detached agent tmux session seeded with the same prompt+args the
 * docker path bakes into `tmux new-session`. carry: rides the job (resolved +
 * approved on the host at submit) and is applied here; `fromBranch` is honored
 * (clone `--branch`), env-file import is still omitted (the docker `-i` worker
 * omits it too).
 */
async function runCloudJob(
  job: QueueJob,
  log: ReturnType<typeof openCommandLog>,
  onBoxCreated: (boxId: string) => void,
): Promise<void> {
  const opts = job.createOpts;
  const cfg = await loadEffectiveConfig(opts.workspace, {
    cliOverrides: buildOverridesFromJob(job),
  });
  const projectRoot = (await findProjectRoot(opts.workspace)).root;
  const providerName = job.providerName || cfg.effective.box.provider || 'docker';
  const provider = await providerForCreate({ flag: providerName, config: cfg.effective });

  const providerDefault = resolveDefaultCheckpoint(cfg.effective, providerName);
  const checkpointRef =
    opts.snapshot && opts.snapshot.length > 0
      ? opts.snapshot
      : providerDefault.length > 0
        ? providerDefault
        : undefined;

  // browser.default = 'playwright' | 'both' implies installing playwright even
  // if box.withPlaywright wasn't explicitly set (mirrors the foreground path).
  const withPlaywright =
    cfg.effective.box.withPlaywright || cfg.effective.browser.default !== 'agent-browser';

  // Re-login in a browser if the host's Claude credentials are expired (surfaced
  // on the job so the hub UI can drive it), before we push them to the cloud box.
  // Cloud's box.image may be a non-docker snapshot id, so the login container
  // (host docker) uses the default box image.
  if (!job.noAgent && job.agent === 'claude-code') {
    await ensureClaudeLoginFresh({ id: job.id, log, image: DEFAULT_BOX_IMAGE, isCloud: true });
  }

  log.write(`creating cloud box (${providerName}) for agent=${job.noAgent ? 'none' : job.agent}`);
  const result = await provider.create({
    workspacePath: opts.workspace,
    name: opts.name && opts.name.length > 0 ? opts.name : undefined,
    // Base ref to seed the box's branch from (hub `--from-branch`). Cloud clone
    // `--branch` accepts branch/tag names but not SHAs; absent → HEAD.
    fromBranch: opts.fromBranch,
    checkpointRef,
    image: cfg.effective.box.image,
    withPlaywright,
    withEnv: cfg.effective.box.withEnv,
    vnc: { enabled: cfg.effective.box.vnc },
    limits: resolveLimits(cfg.effective.box, opts),
    // carry: entries the submitter resolved + approved on the host; the cloud
    // worker runs on the host too, so it reads the files and uploads them.
    carry: opts.carry,
    projectRoot,
    onLog: (line) => log.write(line),
    // Same size / location / session-lifetime resolution the foreground
    // `agentbox create` does, so a queued box isn't sized differently.
    providerOptions: cloudSizingProviderOptions(providerName, cfg.effective),
  });
  log.write(`box created: ${result.record.id}`);

  // Record boxId before the session starts so a crash mid-launch is still
  // attributable to a box and the working-agent gate can join it to its box.
  onBoxCreated(result.record.id);
  if (!job.noAgent) await recordLastAgent(result.record.id, toSyncKind(job.agent)).catch(() => {});
  // Preserve any `login` sub-state a re-login wrote to the manifest: the in-memory
  // `job` predates it, so a bare replace would wipe it mid-stream and the hub could
  // lose the OAuth phase/url or leave the create modal stuck on "Login required".
  const persisted = await readJob(job.id);
  await writeJob({ ...job, boxId: result.record.id, login: persisted?.login });

  // Default-on: write the `~/.agentbox/ssh/config` entry for SSH-capable cloud
  // boxes. The hub's create path lands here (not the CLI `create` command), so
  // this is what makes hub-created Hetzner boxes get their `ssh <box>` alias.
  await autoWriteSshConfig(result.record, provider, cfg.effective.ssh.autoConfig, (m) =>
    log.write(m),
  );

  // "Just create the box": skip the detached agent session (see runDockerJob).
  if (job.noAgent) {
    log.write('no-agent box created; skipping agent session');
    return;
  }

  const seeded = await applySetupWizardPrompt(job, opts.workspace, job.prompt);
  const promptedArgs = buildPromptArgs(job.agent, seeded, job.agentArgs);

  let binary: string;
  let sessionName: string;
  let extraArgs: string[];
  if (job.agent === 'claude-code') {
    binary = 'claude';
    sessionName = cfg.effective.claude.sessionName;
    extraArgs = applyClaudeSkipPermissions(promptedArgs, cfg.effective);
  } else if (job.agent === 'codex') {
    binary = 'codex';
    sessionName = cfg.effective.codex.sessionName;
    extraArgs = applyCodexSkipPermissions(promptedArgs, cfg.effective);
  } else if (job.agent === 'opencode') {
    binary = 'opencode';
    sessionName = cfg.effective.opencode.sessionName;
    extraArgs = promptedArgs;
  } else {
    throw new Error(`unknown agent kind: ${String(job.agent satisfies QueueAgentKind)}`);
  }

  log.write(`starting detached ${job.agent} session`);
  await cloudAgentStartDetached({
    box: result.record,
    binary,
    sessionName,
    extraArgs,
  });

  await maybeOpenQueuedTerminal(job, result.record.name, log);
}

function buildOverridesFromJob(job: QueueJob): Partial<UserConfig> {
  const opts = job.createOpts;
  const box: NonNullable<UserConfig['box']> = {};
  if (opts.hostSnapshot !== undefined) box.hostSnapshot = opts.hostSnapshot;
  if (opts.image !== undefined) box.image = opts.image;
  if (opts.withPlaywright === true) box.withPlaywright = true;
  if (opts.withEnv === true) box.withEnv = true;
  if (opts.vnc === false) box.vnc = false;
  if (opts.sharedDockerCache === true) box.dockerCacheShared = true;
  const out: Partial<UserConfig> = {};
  if (Object.keys(box).length > 0) out.box = box;
  if (opts.portless !== undefined) out.portless = { enabled: opts.portless };
  if (opts.sessionName !== undefined) {
    if (job.agent === 'claude-code') out.claude = { sessionName: opts.sessionName };
    else if (job.agent === 'codex') out.codex = { sessionName: opts.sessionName };
    else if (job.agent === 'opencode') out.opencode = { sessionName: opts.sessionName };
  }
  // Per-box `--no-dangerously-skip-permissions` must survive the queue round-trip
  // so the worker honors the user's safety opt-out instead of the built-in `true`.
  if (opts.dangerouslySkipPermissions !== undefined) {
    if (job.agent === 'claude-code') {
      out.claude = { ...out.claude, dangerouslySkipPermissions: opts.dangerouslySkipPermissions };
    } else if (job.agent === 'codex') {
      out.codex = { ...out.codex, dangerouslySkipPermissions: opts.dangerouslySkipPermissions };
    }
  }
  return out;
}
