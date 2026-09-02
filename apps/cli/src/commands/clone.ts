import { confirm, log, makeProgressReporter, openCommandLog } from '@agentbox/cli-kit';
import { hashProjectPath, registerProject, sanitizeMnemonic } from '@agentbox/config';
import { exportBoxWorkspace } from '@agentbox/sandbox-core';
import { Command } from 'commander';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveBoxOrExit } from '../box-ref.js';
import { streamJobToCompletion } from '../control-plane/job-stream.js';
import { withHubClient } from '../control-plane/with-hub.js';
import { ensureBoxRunningVia } from '../lib/ensure-running.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

/** Default home for a clone's workspace when `--into` isn't given. */
const CLONES_ROOT = join(homedir(), '.agentbox', 'clones');

interface CloneOpts {
  name?: string;
  provider?: string;
  into?: string;
  includeNodeModules?: boolean;
  yes?: boolean;
  /** commander gives `--no-persistent` => false */
  persistent: boolean;
}

/**
 * `agentbox clone <box>` — a new box from the same workspace files and the same
 * `agentbox.yaml`, with a **fresh agent identity**.
 *
 * The clone gets its own host workspace directory (default
 * `~/.agentbox/clones/<name>`), seeded from the source box's current files.
 * That directory is a real project: `agentbox sync` pushes into the clone and
 * `agentbox download` pulls back out of it, exactly as for any other box. It is
 * a TEMPLATE, not a second checkout — `.git` is not exported, because a
 * git-backed second box is what `agentbox create` already gives you.
 *
 * What is deliberately NOT copied is the agent's config volume and its
 * credential: the new box onboards from scratch, so it generates its own
 * identity and carries no channel pairings. There is no `--with-state`.
 */
export const cloneCommand = new Command('clone')
  .description("Create a new box from another box's workspace files, with a fresh agent identity")
  .argument('<box>', 'source box ref: project index, id, id prefix, name, or container')
  .option('-n, --name <name>', 'name for the new box (default: <source>-clone)')
  .option('-p, --provider <name>', "provider for the new box (default: the source box's)")
  .option('--into <dir>', `host dir for the clone's workspace (default: ${CLONES_ROOT}/<name>)`)
  .option('--include-node-modules', 'carry node_modules into the clone as well')
  .option('--no-persistent', 'do not mark the clone as a persistent box')
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(async (idOrName: string, opts: CloneOpts) => {
    const cmdLog = openCommandLog('clone');
    try {
      const source = await resolveBoxOrExit(idOrName);
      const provider = await providerForBox(source);
      const box = await ensureBoxRunningVia(provider, source);

      const cloneName = sanitizeMnemonic(opts.name?.trim() || `${box.name}-clone`);
      const destDir = resolve(opts.into?.trim() || join(CLONES_ROOT, cloneName));
      const providerName = opts.provider ?? box.provider ?? 'docker';

      if (!opts.yes) {
        const ok = await confirm({
          message:
            `Clone ${box.name} into a new ${providerName} box "${cloneName}"?\n` +
            `  workspace files -> ${destDir}\n` +
            `  the agent onboards fresh (no credential, no state dir carried over)`,
          initialValue: true,
        });
        if (!ok) {
          log.info('cancelled');
          return;
        }
      }

      const exported = await exportBoxWorkspace({
        provider,
        box,
        destDir,
        includeNodeModules: opts.includeNodeModules,
        onLog: (line) => {
          log.info(line);
          cmdLog.write(line);
        },
      });
      if (exported.files === 0) {
        log.warn(`${box.name}:/workspace had no files to export; the clone starts empty`);
      }

      // The clone's workspace dir is its own project — register it so the hub,
      // the web UI and `agentbox list` all see it like any other.
      await registerProject(destDir).catch(() => undefined);

      // TODO(phase 1): forward `opts.persistent` as `--persistent` once
      // `BoxRecord.persistent` + the `persistent` create opt land. Until then
      // the flag is accepted and inert, so the documented clone invocation
      // doesn't have to change when persistence ships.
      const s = makeProgressReporter(false);
      s.start(`creating ${cloneName}`);
      const outcome = await withHubClient({ preferLocal: true }, async (client) => {
        const { jobId } = await client.createBox({
          projectId: hashProjectPath(destDir),
          provider: providerName,
          agent: 'none',
          name: cloneName,
          foreground: true,
        });
        cmdLog.write(`enqueued: job ${jobId}`);
        return await streamJobToCompletion(client, jobId, {
          onLine: (line) => {
            s.message(line);
            cmdLog.write(line);
          },
          onStatus: (st) => {
            s.message(`box create: ${st}`);
          },
        });
      });

      if (!outcome) {
        s.stop('failed');
        process.exit(process.exitCode || 1);
      }
      if (outcome.status !== 'done') {
        s.stop('failed');
        log.error(`clone failed: ${outcome.detail ?? outcome.job?.error ?? outcome.status}`);
        process.exit(1);
      }
      s.stop(`box ${cloneName} ready`);
      process.stdout.write(
        `cloned ${box.name} -> ${cloneName}\n` +
          `  workspace: ${destDir} (${String(exported.files)} file(s))\n` +
          `  the agent has NOT been logged in or onboarded — it starts fresh\n`,
      );
    } catch (err) {
      handleLifecycleError(err);
    } finally {
      cmdLog.close();
    }
  });
