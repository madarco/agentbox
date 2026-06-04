import { confirm, isCancel, log } from '@clack/prompts';
import { execa } from 'execa';
import { findProjectRoot } from '@agentbox/config';
import { readState, resolveBoxRef } from '@agentbox/sandbox-core';
import { destroyBox, portlessUnalias } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import { agentboxAliasFor, removeAgentboxSshAlias } from '../ssh-config.js';
import { handleLifecycleError } from './_errors.js';

interface DestroyOptions {
  yes?: boolean;
  keepSnapshot?: boolean;
}

/**
 * Force-remove an orphan docker container that has no `state.json` record —
 * e.g. a create that died after `docker run` but before `recordBox`, or a box
 * whose record was lost. Returns the removed container name, or null when no
 * matching container exists (so the caller can fall through to the normal
 * not-found error). Tries `agentbox-<ref>` and, if the user passed a full
 * container name, `<ref>` verbatim.
 */
async function destroyOrphanContainer(ref: string): Promise<string | null> {
  const candidates = ref.startsWith('agentbox-') ? [ref] : [`agentbox-${ref}`, ref];
  for (const name of candidates) {
    const found = await execa(
      'docker',
      ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'],
      { reject: false },
    );
    if (found.exitCode === 0 && found.stdout.trim() === name) {
      const rm = await execa('docker', ['rm', '-f', name], { reject: false });
      if (rm.exitCode === 0) {
        // Best-effort: drop the portless aliases this box would have registered
        // (`<name>` web + `vnc-<name>`). We have no state record to read them
        // from, but they're derived from the box name, so unalias by convention.
        const boxName = name.startsWith('agentbox-') ? name.slice('agentbox-'.length) : name;
        await portlessUnalias(boxName).catch(() => {});
        await portlessUnalias(`vnc-${boxName}`).catch(() => {});
        return name;
      }
    }
  }
  return null;
}

export const destroyCommand = new Command('destroy')
  .alias('rm')
  .description('Destroy a box and discard its container writable layer (where /workspace lived)')
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--keep-snapshot', "don't delete the snapshot dir under ~/.agentbox/snapshots/")
  .action(async (idOrName: string | undefined, opts: DestroyOptions) => {
    try {
      // Resolve-by-container fallback: an explicit ref that matches no state
      // record may still be a live orphan container (create died before
      // recordBox, or its record was lost). Try to clean it up directly
      // instead of failing with "no agentbox matches".
      if (idOrName !== undefined) {
        const project = await findProjectRoot(process.cwd());
        const hit = resolveBoxRef(idOrName, await readState(), project.root);
        if (hit.kind === 'none') {
          const removed = await destroyOrphanContainer(idOrName);
          if (removed) {
            log.warn(`no state record for "${idOrName}"; removed orphan container ${removed}`);
            log.info('run `agentbox prune -y` to clean any leftover volumes');
            return;
          }
        }
      }
      const box = await resolveBoxOrExit(idOrName);

      if (!opts.yes) {
        log.warn('Will also wipe the box volume and agent work-in-progress');
        const rootBranch = box.gitWorktrees?.find((w) => w.kind === 'root')?.branch;
        const lines = [box.name];
        if (rootBranch) lines.push(`branch:    ${rootBranch}`);
        lines.push(`project: ${box.workspacePath}`);
        if (box.snapshotDir) {
          lines.push(`snapshot:  ${box.snapshotDir}${opts.keepSnapshot ? ' (will be kept)' : ''}`);
        }
        log.info(lines.join('\n'));
        const ok = await confirm({
          message: 'Destroy this box?',
          initialValue: false,
        });
        if (isCancel(ok) || !ok) {
          log.info('cancelled');
          return;
        }
      }

      // Docker boxes still use the rich `destroyBox` path so the user sees
      // container/volume/snapshot accounting. Cloud boxes go through the
      // provider's `destroy`, which deletes the remote sandbox and removes
      // the local record but has no Docker-shaped output to enumerate.
      const providerName = box.provider ?? 'docker';
      if (providerName === 'docker') {
        const result = await destroyBox(box.id, { keepSnapshot: opts.keepSnapshot });
        const out: string[] = [`destroyed ${result.record.container}`];
        if (result.removedContainer) out.push('  ✓ container removed');
        out.push(`  ✓ volumes removed: ${result.removedVolumes.join(', ')}`);
        if (result.removedSnapshot) out.push(`  ✓ snapshot removed: ${result.removedSnapshot}`);
        else if (box.snapshotDir && opts.keepSnapshot) {
          out.push(`  · snapshot kept: ${box.snapshotDir}`);
        }
        process.stdout.write(out.join('\n') + '\n');
      } else {
        const provider = await providerForBox(box);
        await provider.destroy(box);
        // Best-effort: remove the `~/.ssh/config` block `agentbox code` may
        // have written for this cloud box. A missing block isn't an error
        // and a file failure shouldn't block destroy.
        try {
          await removeAgentboxSshAlias(agentboxAliasFor(box.name));
        } catch {
          /* best-effort */
        }
        process.stdout.write(
          `destroyed ${box.name} (${providerName} sandbox ${box.cloud?.sandboxId ?? '<unknown>'})\n`,
        );
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });
