/**
 * `agentbox download --backup` — the CLI half of capturing a bot.
 *
 * The workspace half rides the SAME pull the plain `download` uses, pointed at
 * a different destination; only the state half and the housekeeping are new.
 * That is deliberate: a backup whose file selection differed from a download's
 * would be a second definition of "the box's workspace" to keep in step.
 *
 * Everything a hub route also needs — where the bundle goes, what it captures,
 * the manifest, the prune — lives in `@agentbox/sandbox-core`'s bot-backup
 * concern. What stays here is what only a CLI knows: which flags were passed,
 * and what to print. `resolveBackupTarget`/`prepareBackupDir` are re-exported so
 * `download.ts` keeps importing its target resolution from one place.
 */

import { log } from '@agentbox/cli-kit';
import { join } from 'node:path';
import type { BoxRecord } from '@agentbox/core';
import {
  backupAgentState,
  ensureBackupGitignored,
  linkLatest,
  pruneBackups,
  writeBackupManifest,
  type BackupManifest,
  type BackupTarget,
} from '@agentbox/sandbox-core';
import { pullTransportForBox } from './_agent-pull-transport.js';

export {
  prepareBackupDir,
  resolveBackupTarget,
  type BackupTarget,
  type BackupTargetOptions,
} from '@agentbox/sandbox-core';

/**
 * Everything after the workspace pull: the agent's state dir, the manifest, the
 * `latest` link, the prune, and the gitignore entry.
 *
 * The state half is best-effort by design. A box with no agent, or one whose
 * agent cannot be reached, still produces a usable workspace backup — and the
 * manifest records `state: false` so a later restore knows what it is holding
 * rather than discovering it halfway through.
 */
export async function runBackup(args: {
  box: BoxRecord;
  target: BackupTarget;
  includeNodeModules?: boolean;
}): Promise<{ manifest: BackupManifest; pruned: string[]; wroteGitignore: boolean }> {
  const { box, target } = args;

  let state = false;
  let databases: string[] | undefined;
  if (target.agent) {
    try {
      const { transport } = await pullTransportForBox(box, target.agent);
      const r = await backupAgentState({
        agent: target.agent,
        transport,
        destDir: join(target.dir, 'state'),
      });
      state = true;
      databases = r.databases;
    } catch (err) {
      log.warn(
        `could not capture ${target.agent} state: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const manifest: BackupManifest = {
    version: 1,
    stamp: target.stamp,
    bot: target.bot,
    boxId: box.id,
    boxName: box.name,
    provider: box.provider ?? 'docker',
    ...(target.agent ? { agent: target.agent } : {}),
    state,
    ...(databases && databases.length > 0 ? { databases } : {}),
    ...(args.includeNodeModules ? { includeNodeModules: true } : {}),
  };
  await writeBackupManifest(target.dir, manifest);
  await linkLatest(target.projectRoot, target.bot, target.stamp);

  const pruned = await pruneBackups(target.projectRoot, target.bot, target.keep);
  const wroteGitignore = await ensureBackupGitignored(target.projectRoot);

  return { manifest, pruned, wroteGitignore };
}
