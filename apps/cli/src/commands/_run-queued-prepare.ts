/**
 * Internal worker the relay's queue loop spawns (detached) to run a
 * `kind: 'prepare'` job — bake a provider's base image from the hub, streamed.
 * Hidden from `--help`.
 *
 * Unlike `_run-queued-job` (which creates a box), this calls
 * `provider.prepare({ onLog })` **directly** — NOT the CLI's `runPrepare`, which
 * `process.exit`s, prompts on a TTY, funnels progress into a clack spinner, and
 * discards the result. Every `onLog` line is written to the job log so the hub's
 * per-job SSE streams live progress, exactly like a create job. `provider.prepare`
 * writes the provider's prepared-state marker (`~/.agentbox/<provider>-prepared.json`),
 * which is what `isProviderConfigured` and the create path read — so no project
 * config pin is needed (and there's no project context for a hub bake anyway).
 */

import { Command } from 'commander';
import { loadEffectiveConfig } from '@agentbox/config';
import { readJob, writeJob, type QueueJob } from '@agentbox/relay';
import { openCommandLog } from '../lib/log-file.js';
import { getProvider, isKnownProvider } from '../provider/registry.js';

export const runQueuedPrepareCommand = new Command('_run-queued-prepare')
  .description('internal: run a queued provider image-bake job (do not invoke directly)')
  .argument('<id>', 'queue job id (from ~/.agentbox/queue/<id>.json)')
  .action(async (id: string) => {
    const log = openCommandLog(`queue-${id}`);
    log.write(`prepare worker pid=${String(process.pid)} starting for job ${id}`);
    let job: QueueJob | null = null;
    try {
      job = await readJob(id);
      if (!job) {
        log.write(`FATAL: no manifest at id=${id}`);
        log.close();
        process.exit(64);
      }
      await runPrepareJob(job, log);

      const done: QueueJob = {
        ...job,
        status: 'done',
        finishedAt: new Date().toISOString(),
        exitCode: 0,
      };
      await writeJob(done);
      log.write('done');
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

async function runPrepareJob(
  job: QueueJob,
  log: ReturnType<typeof openCommandLog>,
): Promise<void> {
  const providerName = job.providerName;
  if (!isKnownProvider(providerName)) {
    throw new Error(`unknown provider '${providerName}'`);
  }
  const cwd = job.createOpts?.workspace || process.cwd();
  const cfg = await loadEffectiveConfig(cwd).catch(() => null);
  // Docker base-image registry override (box.imageRegistry; empty = always build).
  const registry = providerName === 'docker' ? cfg?.effective.box.imageRegistry : undefined;
  const claudeInstall =
    job.prepare?.claudeInstall ?? cfg?.effective.box.claudeInstall ?? 'native';

  const provider = await getProvider(providerName);
  if (typeof provider.prepare !== 'function') {
    throw new Error(`provider '${providerName}' does not implement prepare`);
  }

  log.write(`baking ${providerName} (force=${String(job.prepare?.force ?? false)})`);
  const result = await provider.prepare({
    hostWorkspace: cwd,
    force: job.prepare?.force,
    registry,
    claudeInstall,
    onLog: (line) => log.write(line),
  });
  log.write(
    result.snapshotName !== undefined
      ? `prepared ${providerName}: ${result.snapshotName}`
      : `prepared ${providerName}`,
  );
}
