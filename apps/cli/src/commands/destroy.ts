import { confirm, log } from '@agentbox/cli-kit';
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
import { boxOwningHubIsLocal, withOwningHub } from '../control-plane/with-hub.js';
import { handleLifecycleError } from './_errors.js';

interface DestroyOptions {
  yes?: boolean;
  keepSnapshot?: boolean;
  force?: boolean;
}

/** What to do after the hub attempt(s), given whether a hub reaped the box. */
export type DestroyDecision = 'aborted' | 'reap-cleanup' | 'refused' | 'force-cleanup';

/**
 * The safety invariant, isolated + unit-tested: this machine's local record is
 * dropped ONLY when a hub actually reaped the box (`reaped`) or the user forced it
 * (`--force`). A bare `not-found` (no hub owned the box) must NEVER drop the
 * record — it would delete the only handle to a possibly-still-running resource.
 */
export function decideDestroy(
  outcome: 'reaped' | 'not-found' | undefined,
  force: boolean,
): DestroyDecision {
  if (outcome === undefined) return 'aborted'; // hub error; exit code already set
  if (outcome === 'reaped') return 'reap-cleanup';
  return force ? 'force-cleanup' : 'refused';
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
  .option(
    '--force',
    'drop the local record even if no hub owned the box (use only when you are sure the underlying resource is already gone)',
  )
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
      // `withOwningHub` runs it against the hub that OWNS the box (local for
      // docker/remote-docker, configured for cloud) and retries the other distinct
      // hub on `not_found` — so a bare `not_found` never drops a record no hub owns.
      const providerName = box.provider ?? 'docker';
      const r = await withOwningHub(box, (client) =>
        client.destroy(box.id, { keepSnapshot: opts.keepSnapshot }),
      );
      const outcome = r === undefined ? undefined : r === 'ok' ? 'reaped' : 'not-found';
      const decision = decideDestroy(outcome, opts.force === true);
      if (decision === 'aborted') return; // withHubClient reported + set the exit code

      if (decision === 'refused') {
        // No hub AgentBox knows about owns this box. Dropping the local record now
        // would delete the only handle to a possibly-still-running container/VM, so
        // refuse and tell the user how to drop the record deliberately.
        log.error(
          `Box ${box.name} was not found on any hub AgentBox knows — its ${providerName} ` +
            `resource may still be running, so its local record was kept.`,
        );
        log.info(
          `If you're certain the ${providerName} resource is already gone, drop the stale record with ` +
            `\`agentbox destroy ${box.name} --force\`.`,
        );
        process.exitCode = 2;
        return;
      }
      if (decision === 'force-cleanup') {
        log.warn(
          `--force: no hub owned ${box.name}; dropping its local record WITHOUT a confirmed teardown.`,
        );
      }

      // A hub reaped the box (or --force). Client-side cleanup: the laptop keeps an
      // adopted `BoxRecord` + ssh alias for the direct IO plane, and the route only
      // cleaned the HUB's copy of the state (its own machine's, which for a remote
      // hub is the control box). Drop this machine's copy too. A no-op when the hub
      // is co-located (the route already removed the shared record). Best-effort.
      await removeBoxRecord(box.id).catch(() => {});
      await syncAgentboxSshConfig().catch(() => {});

      process.stdout.write(
        boxOwningHubIsLocal(box)
          ? `destroyed ${box.container ?? box.name}\n`
          : `destroyed ${box.name} (${providerName} sandbox ${box.cloud?.sandboxId ?? '<unknown>'})\n`,
      );
    } catch (err) {
      handleLifecycleError(err);
    }
  });
