import { log } from '@agentbox/cli-kit';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import {
  boxOwningHubIsLocal,
  exitCodeForApiError,
  remoteHubHostFileRefusal,
  withHubClient,
} from '../control-plane/with-hub.js';
import { handleLifecycleError } from './_errors.js';

interface UploadOpts {
  includeNodeModules?: boolean;
}

/**
 * `agentbox upload [box]` — the host→box direction, the mirror of
 * `agentbox download`.
 *
 * The box always wins: a merge never resets the box's branch, and a file the
 * box has changed is left alone and reported. That is the same policy the
 * session-start resync has always used; this command just makes it reachable
 * on demand, and adds the leg a non-git workspace needs (a service box's
 * `/workspace` is often a plain directory that no `git merge` can reach).
 *
 * A thin client of `POST /api/v1/boxes/:id/upload` — the hub runs the push, so
 * the web UI and the tray get the same operation from the same implementation
 * (`docs/hub-api-single-path-plan.md`). It also means the hub starts the box if
 * it is paused, which is why there is no `ensureBoxRunning` here.
 *
 * ONE thing this cannot do remotely: the hub reads the host side of the
 * workspace off its OWN disk, so a box owned by a control box is refused rather
 * than uploaded from the wrong tree — see {@link remoteHubHostFileRefusal}.
 */
export const uploadCommand = new Command('upload')
  .description("Push your host workspace into a live box's /workspace (box wins on conflict)")
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--include-node-modules', 'also push node_modules (non-git workspaces only)')
  .action(async (idOrName: string | undefined, opts: UploadOpts) => {
    try {
      const box = await resolveBoxOrExit(idOrName);

      const refusal = await remoteHubHostFileRefusal(box, 'upload');
      if (refusal) {
        log.error(refusal);
        process.exitCode = exitCodeForApiError('conflict');
        return;
      }

      await withHubClient({ preferLocal: boxOwningHubIsLocal(box) }, async (client) => {
        const result = await client.uploadBox(box.id, {
          includeNodeModules: opts.includeNodeModules === true,
        });

        if (result.mode === 'files') {
          process.stdout.write(
            `synced ${String(result.copied)} file(s) from ${box.workspacePath} into ${box.name}:/workspace (exclude-list mode)\n`,
          );
        } else {
          process.stdout.write(
            `synced ${box.workspacePath} into ${box.name} (git merge + overlay)\n`,
          );
        }

        if (result.conflicts.length > 0) {
          log.warn(
            `${String(result.conflicts.length)} host change(s) were SKIPPED to keep the box's version:\n` +
              result.conflicts.map((p) => `  ${p}`).join('\n'),
          );
        }
      });
    } catch (err) {
      handleLifecycleError(err);
    }
  });
