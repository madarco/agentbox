import { confirm, log, makeProgressReporter, openCommandLog } from '@agentbox/cli-kit';
import { sanitizeMnemonic } from '@agentbox/config';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { streamJobToCompletion } from '../control-plane/job-stream.js';
import { boxOwningHubIsLocal, withHubClient } from '../control-plane/with-hub.js';
import { isAbsolute, resolve } from 'node:path';
import { handleLifecycleError } from './_errors.js';

/**
 * `--into`, made absolute against the CALLER's working directory.
 *
 * The one thing only this side knows. A cwd is client state and does not travel
 * over an API: the hub is a long-lived daemon started in some arbitrary
 * directory (and may be a control box on another machine entirely), so a
 * relative path sent as-is would land the clone's workspace — and its project
 * registration — wherever that daemon happens to live. The API refuses a
 * relative `into` for exactly that reason, so resolving here is what keeps
 * `agentbox clone --into ./svc` meaning what the user typed.
 *
 * Note the asymmetry that follows and is intended: the path is resolved against
 * YOUR cwd but names a directory on the HUB's filesystem. They are the same
 * machine for a local hub, which is the case `--into` is for.
 */
export function resolveIntoDir(
  raw: string | undefined,
  cwd: string = process.cwd(),
): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  // A `~` that reached us un-expanded (it was quoted) is the same class of bug
  // one level up: it means "home", and WHOSE home is exactly what a path bound
  // for another machine cannot answer. Resolving it would silently create a
  // directory literally named `~`, so say so instead.
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) {
    throw new Error(
      `--into ${t}: '~' is not expanded here — it names a directory on the hub's machine, whose ` +
        'home is not necessarily yours. Write the path out, or leave --into off for the default ' +
        "~/.agentbox/clones/<name> (resolved in the hub user's home).",
    );
  }
  return isAbsolute(t) ? t : resolve(cwd, t);
}

interface CloneOpts {
  name?: string;
  provider?: string;
  into?: string;
  includeNodeModules?: boolean;
  yes?: boolean;
  /**
   * `--persistent` / `--no-persistent`. Both are declared so commander leaves
   * this `undefined` when neither was passed — absent means "inherit the source
   * box's persistence", which `false` would silently override.
   */
  persistent?: boolean;
}

/**
 * `agentbox clone <box>` — a new box from the same workspace files and the same
 * `agentbox.yaml`, with a **fresh agent identity**.
 *
 * The clone gets its own workspace directory (default
 * `~/.agentbox/clones/<name>`) on the machine running the hub, and that
 * directory is a real project: `agentbox upload` pushes into the clone and
 * `agentbox download` pulls back out of it, exactly as for any other box. It is
 * a TEMPLATE, not a second checkout — `.git` is not exported, because a
 * git-backed second box is what `agentbox create` already gives you.
 *
 * What is deliberately NOT copied is the agent's config volume and its
 * credential: the new box onboards from scratch, so it generates its own
 * identity and carries no channel pairings. There is no `--with-state`.
 *
 * ONE call, not two: `POST /api/v1/boxes/:id/clone` does the export AND enqueues
 * the create. The export reads the SOURCE BOX, which the hub can reach on every
 * provider, so there is no reason for the CLI to hold a provider handle — and
 * doing it here would have been a second implementation the web UI and the tray
 * could not use (`docs/hub-api-single-path-plan.md`).
 */
export const cloneCommand = new Command('clone')
  .description("Create a new box from another box's workspace files, with a fresh agent identity")
  .argument('<box>', 'source box ref: project index, id, id prefix, name, or container')
  .option('-n, --name <name>', 'name for the new box (default: <source>-clone)')
  .option('-p, --provider <name>', "provider for the new box (default: the source box's)")
  .option(
    '--into <dir>',
    "dir for the clone's workspace on the hub's machine (relative paths resolve against your cwd; default: ~/.agentbox/clones/<name>)",
  )
  .option('--include-node-modules', 'carry node_modules into the clone as well')
  .option(
    '--persistent',
    'always-on clone (default: inherit the source box — a service box clones to a service box)',
  )
  .option('--no-persistent', 'expendable clone even when the source box is always-on')
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(async (idOrName: string, opts: CloneOpts) => {
    const cmdLog = openCommandLog('clone');
    try {
      const source = await resolveBoxOrExit(idOrName);
      // Display values only — the hub re-resolves both and its answer is the one
      // reported, so a default that ever diverges shows up in the output rather
      // than in a second copy of the naming rule.
      const cloneName = sanitizeMnemonic(opts.name?.trim() || `${source.name}-clone`);
      const providerName = opts.provider ?? source.provider ?? 'docker';
      const into = resolveIntoDir(opts.into);

      if (!opts.yes) {
        const ok = await confirm({
          message:
            `Clone ${source.name} into a new ${providerName} box "${cloneName}"?\n` +
            `  workspace files -> ${into ?? `~/.agentbox/clones/${cloneName}`} (on the hub's machine)\n` +
            `  the agent onboards fresh (no credential, no state dir carried over)`,
          initialValue: true,
        });
        if (!ok) {
          log.info('cancelled');
          return;
        }
      }

      const s = makeProgressReporter(false);
      s.start(`cloning ${source.name}`);
      const outcome = await withHubClient(
        { preferLocal: boxOwningHubIsLocal(source) },
        async (client) => {
          const staged = await client.cloneBox(source.id, {
            name: opts.name?.trim() || undefined,
            provider: opts.provider?.trim() || undefined,
            into,
            includeNodeModules: opts.includeNodeModules === true,
            persistent: opts.persistent,
          });
          cmdLog.write(
            `staged: ${String(staged.files)} file(s) -> ${staged.workspace}; job ${staged.jobId}`,
          );
          if (staged.files === 0) {
            s.message(`${source.name}:/workspace had no files to export; the clone starts empty`);
          }
          s.message(`creating ${staged.name}`);
          const result = await streamJobToCompletion(client, staged.jobId, {
            onLine: (line) => {
              s.message(line);
              cmdLog.write(line);
            },
            onStatus: (st) => {
              s.message(`box create: ${st}`);
            },
          });
          return { staged, result };
        },
      );

      if (!outcome) {
        s.stop('failed');
        process.exit(process.exitCode || 1);
      }
      const { staged, result } = outcome;
      if (result.status !== 'done') {
        s.stop('failed');
        log.error(`clone failed: ${result.detail ?? result.job?.error ?? result.status}`);
        process.exit(1);
      }
      s.stop(`box ${staged.name} ready`);
      process.stdout.write(
        `cloned ${source.name} -> ${staged.name}\n` +
          `  workspace: ${staged.workspace} (${String(staged.files)} file(s))\n` +
          `  the agent has NOT been logged in or onboarded — it starts fresh\n`,
      );
    } catch (err) {
      handleLifecycleError(err);
    } finally {
      cmdLog.close();
    }
  });
