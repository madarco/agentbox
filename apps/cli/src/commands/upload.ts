import { log } from '@agentbox/cli-kit';
import { Command } from 'commander';
import { uploadWorkspaceToBox } from '@agentbox/sandbox-core';
import { resolveBoxOrExit } from '../box-ref.js';
import { ensureBoxRunningVia } from '../lib/ensure-running.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

interface SyncOpts {
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
 */
export const uploadCommand = new Command('upload')
  .description("Push your host workspace into a live box's /workspace (box wins on conflict)")
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--include-node-modules', 'also push node_modules (non-git workspaces only)')
  .action(async (idOrName: string | undefined, opts: SyncOpts) => {
    try {
      const resolved = await resolveBoxOrExit(idOrName);
      const provider = await providerForBox(resolved);
      const box = await ensureBoxRunningVia(provider, resolved);

      const result = await uploadWorkspaceToBox({
        provider,
        box,
        includeNodeModules: opts.includeNodeModules,
        onLog: (line) => {
          log.info(line);
        },
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
    } catch (err) {
      handleLifecycleError(err);
    }
  });
