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
import type { BoxRecord } from '@agentbox/core';
import { Command } from 'commander';
import { collect } from '../lib/collect.js';
import { resolveBoxOrExit } from '../box-ref.js';
import { boxOwningHubIsLocal, withOwningHub } from '../control-plane/with-hub.js';
import { handleLifecycleError } from './_errors.js';

interface DestroyOptions {
  yes?: boolean;
  keepSnapshot?: boolean;
  force?: boolean;
  /** Repeatable `--box`: destroy several boxes in one call. */
  box: string[];
}

/** Per-box result of a batch destroy, folded into one exit code. */
export type DestroyOutcome = 'destroyed' | 'refused' | 'error' | 'cancelled';

/**
 * The exit code for a batch: the worst outcome wins, and a batch never reports
 * success because SOME box was destroyed. `cancelled` is the user's own answer,
 * so it is not a failure.
 */
export function decideDestroyBatch(outcomes: readonly DestroyOutcome[]): number {
  if (outcomes.includes('error')) return 1;
  if (outcomes.includes('refused')) return 2;
  return 0;
}

/**
 * The command's final exit code, given the batch outcomes and whatever
 * `withHubClient` already put on `process.exitCode`.
 *
 * The hub's own code (3 unauthorized, 4 invalid_request, 5 conflict, 6
 * backend_unavailable) is strictly more informative than the batch's generic 1,
 * so an `error` outcome keeps it — a single-box destroy surfaced 3 long before
 * this command learned to take several boxes, and flattening that was a
 * regression. `refused` (2) and success (0) imply no hub error happened at all,
 * so they are never overridden.
 */
export function resolveDestroyExit(outcomes: readonly DestroyOutcome[], hubCode: number): number {
  const batch = decideDestroyBatch(outcomes);
  return batch === 1 && hubCode > 1 ? hubCode : batch;
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
 * Identify an orphan docker container behind a ref that matches no `state.json`
 * record — a create that died after `docker run` but before `recordBox`, or a box
 * whose record was lost. Tries `agentbox-<ref>` and, if the user passed a full
 * container name, `<ref>` verbatim; null when there is none, so the caller falls
 * through to the normal not-found error.
 *
 * Deliberately READ-ONLY: it runs while refs are still being validated, so it
 * must not delete anything a later bad ref (or a `no` at the confirmation) would
 * have made the wrong call.
 */
async function findOrphanContainer(ref: string | undefined): Promise<string | null> {
  if (ref === undefined) return null;
  const project = await findProjectRoot(process.cwd());
  if (resolveBoxRef(ref, await readState(), project.root).kind !== 'none') return null;
  const candidates = ref.startsWith('agentbox-') ? [ref] : [`agentbox-${ref}`, ref];
  for (const name of candidates) {
    const found = await execa(
      'docker',
      ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'],
      { reject: false },
    );
    if (found.exitCode === 0 && found.stdout.trim() === name) return name;
  }
  return null;
}

/** Remove a container {@link findOrphanContainer} already identified. */
async function reapOrphanContainer(name: string): Promise<DestroyOutcome> {
  const rm = await execa('docker', ['rm', '-f', name], { reject: false });
  if (rm.exitCode !== 0) {
    log.error(`could not remove orphan container ${name}: ${rm.stderr.trim()}`);
    return 'error';
  }
  // Best-effort: drop the portless aliases this box would have registered
  // (`<name>` web + `vnc-<name>`). We have no state record to read them from,
  // but they're derived from the box name, so unalias by convention.
  const boxName = name.startsWith('agentbox-') ? name.slice('agentbox-'.length) : name;
  await portlessUnalias(boxName).catch(() => {});
  await portlessUnalias(`vnc-${boxName}`).catch(() => {});
  log.warn(`no state record for "${name}"; removed orphan container`);
  log.info('run `agentbox prune -y` to clean any leftover volumes');
  return 'destroyed';
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
  .option(
    '--box <ref>',
    'box to destroy; repeatable — destroys each in turn after ONE confirmation',
    collect,
    [] as string[],
  )
  .action(async (idOrName: string | undefined, opts: DestroyOptions) => {
    try {
      if (idOrName !== undefined && opts.box.length > 0) {
        log.error('pass the box as an argument OR with --box (repeatable), not both');
        process.exitCode = 2;
        return;
      }
      const refs = opts.box.length > 0 ? opts.box : [idOrName];
      const outcomes: DestroyOutcome[] = [];
      const boxes: BoxRecord[] = [];
      // Orphans are IDENTIFIED here and reaped further down, after every ref has
      // resolved and the user has confirmed. Reaping inside this loop deleted
      // containers before a later typo aborted the run — and before a `no` at the
      // prompt that could not undo them.
      const orphans: string[] = [];
      for (const ref of refs) {
        const orphan = await findOrphanContainer(ref);
        if (orphan) {
          if (!orphans.includes(orphan)) orphans.push(orphan);
          continue;
        }
        // A ref that resolves to nothing exits here, BEFORE anything in the
        // batch is torn down — a typo must not destroy the boxes around it.
        const box = await resolveBoxOrExit(ref);
        if (boxes.some((b) => b.id === box.id)) continue; // same box named twice
        boxes.push(box);
      }

      // An always-on box is not expendable, so `-y` alone does not destroy one.
      // `--force` is the override (it already exists for dropping a record no
      // hub owns). Refused on its own — it does not cancel the rest of the batch.
      const eligible: BoxRecord[] = [];
      for (const box of boxes) {
        if (box.persistent && opts.yes && !opts.force) {
          log.error(
            `${box.name} is a persistent (always-on) box; -y does not destroy one. ` +
              `Re-run without -y to confirm interactively, or pass --force.`,
          );
          outcomes.push('refused');
          continue;
        }
        eligible.push(box);
      }
      if (eligible.length === 0 && orphans.length === 0) {
        process.exitCode = decideDestroyBatch(outcomes);
        return;
      }

      // ONE confirmation for the whole set — four boxes must not mean four prompts.
      const total = eligible.length + orphans.length;
      if (!opts.yes) {
        log.warn('Will also wipe the box volume and agent work-in-progress');
        const blocks = [
          ...eligible.map((b) => describeForDestroy(b, opts)),
          ...orphans.map((c) => `${c}\norphan container (no state record)`),
        ];
        log.info(blocks.join('\n\n'));
        const ok = await confirm({
          message: total > 1 ? `Destroy these ${total} boxes?` : 'Destroy this box?',
          initialValue: false,
        });
        if (!ok) {
          log.info('cancelled');
          return;
        }
      }

      // Orphans first: they are a local docker `rm -f` with no hub round trip, so
      // doing them before the slow path keeps a confirmed teardown from being
      // half-applied if a later hub call hangs.
      for (const container of orphans) outcomes.push(await reapOrphanContainer(container));

      // Sequential: each is a hub round trip plus local cleanup, and one failure
      // must not strand the boxes behind it.
      for (const box of eligible) outcomes.push(await destroyOne(box, opts));

      if (total > 1) {
        // stderr: the `destroyed <box>` lines above are the parseable output,
        // and a summary glued onto them would break a caller reading stdout.
        const done = outcomes.filter((o) => o === 'destroyed').length;
        process.stderr.write(`destroyed ${done}/${outcomes.length}\n`);
      }
      process.exitCode = resolveDestroyExit(
        outcomes,
        typeof process.exitCode === 'number' ? process.exitCode : 0,
      );
    } catch (err) {
      handleLifecycleError(err);
    }
  });

/** The confirmation block for one box. */
function describeForDestroy(box: BoxRecord, opts: DestroyOptions): string {
  const rootBranch = box.gitWorktrees?.find((w) => w.kind === 'root')?.branch;
  const lines = [box.name];
  if (box.persistent) lines.push('persistent: yes (always-on box)');
  if (rootBranch) lines.push(`branch:    ${rootBranch}`);
  lines.push(`project: ${box.workspacePath}`);
  if (box.snapshotDir) {
    lines.push(`snapshot:  ${box.snapshotDir}${opts.keepSnapshot ? ' (will be kept)' : ''}`);
  }
  return lines.join('\n');
}

/** Tear one box down through the hub that owns it, and reap this machine's copy. */
async function destroyOne(box: BoxRecord, opts: DestroyOptions): Promise<DestroyOutcome> {
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
  if (decision === 'aborted') return 'error'; // withHubClient reported + set the exit code

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
    return 'refused';
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
  return 'destroyed';
}
