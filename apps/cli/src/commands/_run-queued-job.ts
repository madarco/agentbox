/**
 * Internal worker the relay's queue loop spawns as a detached child to run a
 * queued `-i` job. Hidden from `--help`. Reads a queue manifest by id, runs
 * the same `createBox` + `startXxxSession` codepath the foreground claude /
 * codex / opencode commands run in non-`-i` mode, then exits when tmux is up.
 * **Never** attaches — the in-box session keeps running for the user to
 * re-attach later.
 */

import { Command } from 'commander';
import {
  findProjectRoot,
  loadEffectiveConfig,
  resolveDefaultCheckpoint,
  type UserConfig,
} from '@agentbox/config';
import {
  createBox,
  rebuildPluginNativeDeps,
  SHARED_CLAUDE_VOLUME,
  startClaudeSession,
  startCodexSession,
  startOpencodeSession,
  ensureCodexInstalled,
  ensureOpencodeInstalled,
} from '@agentbox/sandbox-docker';
import { readJob, writeJob, type QueueAgentKind, type QueueJob } from '@agentbox/relay';
import { resolveClaudeAuth } from '../auth.js';
import { resolveLimits } from '../limits.js';
import { openCommandLog } from '../lib/log-file.js';
import { buildPromptArgs } from '../lib/queue/build-prompt-args.js';

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

      // Run the create + session path. Cloud paths are intentionally NOT
      // supported here (the cloud agent attach starts the tmux session lazily
      // on first attach; with no attach there's nowhere to seed the prompt).
      // The submit-side already rejected cloud in that case.
      // The worker records boxId on the outer `job` the instant the box is
      // created (via onBoxCreated), so the catch block below preserves the
      // box attribution even if the session start throws afterwards.
      await runDockerJob(job, log, (boxId) => {
        if (job) job = { ...job, boxId };
      });

      const done: QueueJob = {
        ...job,
        status: 'done',
        finishedAt: new Date().toISOString(),
        exitCode: 0,
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
          const failed: QueueJob = {
            ...job,
            status: 'failed',
            finishedAt: new Date().toISOString(),
            reason: err instanceof Error ? err.message : String(err),
            exitCode: 1,
          };
          await writeJob(failed);
        } catch {
          /* best-effort */
        }
      }
      log.close();
      process.exit(1);
    }
  });

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
  if (providerName !== 'docker') {
    throw new Error(`worker only supports docker provider (got "${providerName}")`);
  }
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
  // need a host-env probe (they ride the in-box volume that login seeded).
  const resolved =
    job.agent === 'claude-code' ? await resolveClaudeAuth(process.env) : null;

  // browser.default = 'playwright' | 'both' implies installing playwright
  // even if box.withPlaywright wasn't explicitly set.
  const withPlaywright =
    cfg.effective.box.withPlaywright || cfg.effective.browser.default !== 'agent-browser';

  log.write(`creating box for agent=${job.agent}`);
  const result = await createBox({
    workspacePath: opts.workspace,
    name: opts.name && opts.name.length > 0 ? opts.name : undefined,
    useSnapshot,
    checkpointRef,
    image: cfg.effective.box.image,
    claudeConfig:
      job.agent === 'claude-code'
        ? { isolate: cfg.effective.box.isolateClaudeConfig }
        : undefined,
    codexConfig:
      job.agent === 'codex'
        ? { isolate: cfg.effective.box.isolateCodexConfig }
        : undefined,
    opencodeConfig:
      job.agent === 'opencode'
        ? { isolate: cfg.effective.box.isolateOpencodeConfig }
        : undefined,
    claudeEnv: resolved?.env,
    withPlaywright,
    withEnv: cfg.effective.box.withEnv,
    vnc: { enabled: cfg.effective.box.vnc },
    docker: { sharedCache: cfg.effective.box.dockerCacheShared },
    // Background jobs do not negotiate Portless interactively. If the user
    // explicitly set --portless / --no-portless we honor it, else leave
    // undefined so the create path skips the live prompt.
    portless: opts.portless,
    portlessStateDir: cfg.effective.portless.stateDir || undefined,
    limits: resolveLimits(cfg.effective.box, opts),
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
  await writeJob({ ...job, boxId: result.record.id });

  const promptedArgs = buildPromptArgs(job.agent, job.prompt, job.agentArgs);

  if (job.agent === 'claude-code') {
    log.write(`checking plugin native deps`);
    await rebuildPluginNativeDeps(result.record.container, {
      volume: result.record.claudeConfigVolume ?? SHARED_CLAUDE_VOLUME,
      onProgress: (line) => log.write(line),
    });
    log.write(`starting claude session`);
    await startClaudeSession({
      container: result.record.container,
      claudeArgs: promptedArgs,
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
      codexArgs: promptedArgs,
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
  return out;
}
