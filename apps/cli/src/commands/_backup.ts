/**
 * `agentbox download --backup` — the CLI half of capturing a bot.
 *
 * The workspace half rides the SAME pull the plain `download` uses, pointed at
 * a different destination; only the state half and the housekeeping are new.
 * That is deliberate: a backup whose file selection differed from a download's
 * would be a second definition of "the box's workspace" to keep in step.
 *
 * The decisions live in `@agentbox/sandbox-core`'s bot-backup concern so a hub
 * route can reuse them. What stays here is what only a CLI knows: which flags
 * were passed, and what to print.
 */

import { log } from '@agentbox/cli-kit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentId, BoxRecord } from '@agentbox/core';
import {
  backupAgentState,
  backupStamp,
  botBackupDir,
  ensureBackupGitignored,
  findAgentSpec,
  linkLatest,
  pruneBackups,
  writeBackupManifest,
  type BackupManifest,
} from '@agentbox/sandbox-core';
import { pullTransportForBox } from './_agent-pull-transport.js';

const DEFAULT_KEEP = 3;

export interface BackupTarget {
  /** The project the bundle is written under. */
  projectRoot: string;
  bot: string;
  stamp: string;
  /** `<project>/.agentbox/bots/<bot>/<stamp>`. */
  dir: string;
  /** Where the workspace pull lands. */
  workspaceDir: string;
  keep: number;
  /** The agent whose state to capture; absent when the box has no known one. */
  agent?: AgentId;
}

/**
 * Where this backup goes, and what it will capture.
 *
 * `projectRoot ?? workspacePath` is the fallback the hub already uses: the field
 * is absent on records made before it existed, and a backup must not silently
 * pick a different directory for an old box.
 */
export function resolveBackupTarget(
  box: BoxRecord,
  opts: { name?: string; keep?: string; agent?: string },
): BackupTarget {
  const projectRoot = box.projectRoot ?? box.workspacePath;
  const bot = (opts.name ?? box.name).trim();
  if (bot.length === 0 || bot.includes('/') || bot === '.' || bot === '..') {
    throw new Error(`--name ${opts.name ?? ''}: a bot name must be a single path segment`);
  }

  const keep = opts.keep === undefined ? DEFAULT_KEEP : Number.parseInt(opts.keep, 10);
  if (!Number.isFinite(keep) || keep < 1) {
    throw new Error(`--keep ${opts.keep ?? ''}: expected a positive integer`);
  }

  // An explicit `--agent` is checked; a guess off the record is not, because a
  // box whose recorded agent has since been removed from the registry should
  // still get its workspace backed up.
  let agent: AgentId | undefined;
  if (opts.agent) {
    const spec = findAgentSpec(opts.agent);
    if (!spec) throw new Error(`--agent ${opts.agent}: no such agent`);
    agent = spec.id;
  } else {
    const guess = box.lastAgent ?? box.agents?.[0];
    agent = guess ? findAgentSpec(guess)?.id : undefined;
  }

  const stamp = backupStamp();
  const dir = botBackupDir(projectRoot, bot, stamp);
  return { projectRoot, bot, stamp, dir, workspaceDir: join(dir, 'workspace'), keep, agent };
}

/**
 * Create the bundle's directories before the pull runs.
 *
 * rsync creates the LAST component of its destination and no more, so a fresh
 * `<project>/.agentbox/bots/<bot>/<stamp>/workspace` is several levels too deep
 * for it and the transfer dies with "No such file or directory". The dry-run
 * pass hits it too, so this cannot wait until the write.
 */
export async function prepareBackupDir(target: BackupTarget): Promise<void> {
  await mkdir(target.workspaceDir, { recursive: true });
}

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
