import { confirm, log } from '../lib/prompt.js';
import { execa } from 'execa';
import { findProjectRoot } from '@agentbox/config';
import {
  readState,
  removeBoxRecord,
  resolveBoxRef,
  syncAgentboxSshConfig,
} from '@agentbox/sandbox-core';
import { portlessUnalias } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { HubApiError } from '../control-plane/hub-api-client.js';
import { withHubClient } from '../control-plane/with-hub.js';
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
      // instead of failing with "no agentbox matches". This is local docker
      // recovery — the hub can't drive a box that was never registered.
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
        if (!ok) {
          log.info('cancelled');
          return;
        }
      }

      // The hub's destroy route tears down the provider resource AND reaps the
      // store/custody registration (`hub-backend.ts`), so this is one call in both
      // modes — no separate control-box reap. `keepSnapshot` travels on the body.
      const destroyed = await withHubClient({}, async (client) => {
        try {
          await client.destroy(box.id, { keepSnapshot: opts.keepSnapshot });
        } catch (err) {
          // Already gone on the hub (e.g. reaped elsewhere): still fall through to
          // the local-record cleanup below so this machine's adopted record + ssh
          // alias don't linger. Destroy stays idempotent.
          if (err instanceof HubApiError && err.code === 'not_found') return true;
          throw err;
        }
        return true;
      });
      if (!destroyed) return;

      // Client-side cleanup: the laptop keeps an adopted `BoxRecord` + ssh alias
      // for the direct IO plane, and the route only cleaned the HUB's copy of the
      // state (its own machine's, which for a remote hub is the control box). Drop
      // this machine's copy too. A no-op when the hub is co-located (the route
      // already removed the shared record). Best-effort — the teardown is done.
      await removeBoxRecord(box.id).catch(() => {});
      await syncAgentboxSshConfig().catch(() => {});

      const providerName = box.provider ?? 'docker';
      process.stdout.write(
        providerName === 'docker'
          ? `destroyed ${box.container ?? box.name}\n`
          : `destroyed ${box.name} (${providerName} sandbox ${box.cloud?.sandboxId ?? '<unknown>'})\n`,
      );
    } catch (err) {
      handleLifecycleError(err);
    }
  });
