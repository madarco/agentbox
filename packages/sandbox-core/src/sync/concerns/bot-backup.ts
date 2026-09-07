/**
 * Concern: bot backups — capturing a running box as a set of files that can
 * recreate it, on any provider.
 *
 * A service bot (openclaw today) is a **workspace plus an agent state dir**.
 * Provider checkpoints cannot express that: they are provider-native snapshots
 * and do not cross from e2b to hetzner. A file-shaped bundle does.
 *
 * The bundle lives INSIDE the project, at
 * `<project>/.agentbox/bots/<bot>/<stamp>/`, because `~/.agentbox/` holds copies
 * AgentBox keeps for its own use, not a user's source of truth. That placement
 * is only safe because of the other half of this change: the workspace SEED now
 * drops `.agentbox/` too (`seedExcludeTarArgs`), so a backup is never copied
 * into the next box. The gitignore entry this module writes is the second guard,
 * not the only one.
 *
 * WHAT THIS DELIBERATELY DOES NOT REUSE: `staticPaths[].exclude`. That list is
 * push-direction hygiene and for openclaw it is exactly the identity —
 * `openclaw.json`, the config-journal key, the live `state/`. A backup that
 * dropped them would restore a DIFFERENT bot, which is not a restore. The agent
 * says what a capture must leave behind through `stateBackup.exclude` instead.
 */

import { execa } from 'execa';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentId, SyncTransport } from '@agentbox/core';
import { LIVE_DATABASE_EXCLUDES } from '@agentbox/core';
import { resolveAgentSpec } from '../registry.js';
import { agentPullBoxDir, pullSqliteSnapshot } from '../agent-pull-module.js';

/** Directory under a project that holds every bot's backups. */
export const BOTS_DIR_REL = join('.agentbox', 'bots');

/** The single `.gitignore` entry that keeps all of it out of the project repo. */
export const BACKUP_GITIGNORE_ENTRY = '.agentbox/';

/**
 * A backup's timestamp, and its directory name.
 *
 * Chosen so a lexicographic sort is a chronological one — `readdir` order is
 * not defined, and every consumer here (prune, `latest`, "which is newest")
 * needs an order. `:` is out because it is not a portable path character.
 */
export function backupStamp(at: Date = new Date()): string {
  return at
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-');
}

/** `<project>/.agentbox/bots/<bot>`. */
export function botDir(projectRoot: string, bot: string): string {
  return join(projectRoot, BOTS_DIR_REL, bot);
}

/** `<project>/.agentbox/bots/<bot>/<stamp>`. */
export function botBackupDir(projectRoot: string, bot: string, stamp: string): string {
  return join(botDir(projectRoot, bot), stamp);
}

/** What a backup records about itself, for a later `--restore`. */
export interface BackupManifest {
  version: 1;
  stamp: string;
  bot: string;
  boxId: string;
  boxName: string;
  provider: string;
  /** The agent whose state was captured; absent when the box has none. */
  agent?: AgentId;
  /** False when only the workspace was captured. */
  state: boolean;
  /** Relative paths captured through the SQLite online-backup API. */
  databases?: string[];
  /** Whether `node_modules` was kept in the workspace half. */
  includeNodeModules?: boolean;
  createdBy?: string;
}

export async function writeBackupManifest(dir: string, m: BackupManifest): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`, 'utf8');
}

/**
 * Point `<bot>/latest` at `stamp`.
 *
 * A RELATIVE link, so moving or copying the whole project keeps it valid — an
 * absolute one would silently dangle the moment the bundle is shared, which is
 * one of the things a backup is for.
 */
export async function linkLatest(projectRoot: string, bot: string, stamp: string): Promise<void> {
  const link = join(botDir(projectRoot, bot), 'latest');
  await rm(link, { force: true });
  await symlink(stamp, link);
}

/** The backup directory names under `<bot>`, newest first. */
export async function listBackups(projectRoot: string, bot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(botDir(projectRoot, bot));
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of entries) {
    if (name === 'latest') continue;
    const st = await lstat(join(botDir(projectRoot, bot), name)).catch(() => null);
    if (st?.isDirectory()) dirs.push(name);
  }
  return dirs.sort().reverse();
}

/**
 * Keep the `keep` newest backups, remove the rest. Returns what was removed.
 *
 * Never removes what `latest` points at, even if the count says it should: a
 * dangling `latest` is a worse outcome than one extra directory, and the only
 * way the two disagree is a `latest` written by hand.
 */
export async function pruneBackups(
  projectRoot: string,
  bot: string,
  keep: number,
): Promise<string[]> {
  if (keep < 1) return [];
  const all = await listBackups(projectRoot, bot);
  const current = await readlink(join(botDir(projectRoot, bot), 'latest')).catch(() => null);
  const removed: string[] = [];
  for (const name of all.slice(keep)) {
    if (name === current) continue;
    await rm(join(botDir(projectRoot, bot), name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * Make sure `.agentbox/` is gitignored in `projectRoot`, and say whether the
 * entry had to be written.
 *
 * Asks `git check-ignore` rather than grepping `.gitignore`: the entry may
 * already come from the user's global excludes file, a parent repo, or a
 * differently-spelled rule, and appending a duplicate to someone's file is
 * rude. A non-repo is a no-op, not an error — a bot's project need not be a
 * git repo at all, and that path has no way to leak a backup into a box anyway
 * (the untracked carry-over only exists for a repo).
 *
 * The probe is a path INSIDE the dir, not the dir itself. MEASURED: against a
 * `.agentbox/` rule, `git check-ignore .agentbox` exits 1 — a trailing-slash
 * pattern matches directories only, and git cannot tell that a path which does
 * not exist yet is one. A file under it matches whichever way the rule is
 * spelled, and "would the file I am about to write be ignored" is the question
 * that actually matters.
 */
export async function ensureBackupGitignored(projectRoot: string): Promise<boolean> {
  const inRepo = await execa('git', ['-C', projectRoot, 'rev-parse', '--git-dir'], {
    reject: false,
  });
  if (inRepo.exitCode !== 0) return false;

  const probe = join(BOTS_DIR_REL, '.probe');
  const ignored = await execa('git', ['-C', projectRoot, 'check-ignore', '-q', probe], {
    reject: false,
  });
  if (ignored.exitCode === 0) return false;

  const path = join(projectRoot, '.gitignore');
  const existing = await readFile(path, 'utf8').catch(() => '');
  const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  await writeFile(
    path,
    `${existing}${prefix}\n# AgentBox bot backups (workspace + agent identity). Never commit these.\n${BACKUP_GITIGNORE_ENTRY}\n`,
    'utf8',
  );
  return true;
}

export interface AgentStateBackupResult {
  /** Relative paths captured through the SQLite online-backup API. */
  databases: string[];
  /** Patterns the agent asked to leave behind. */
  excluded: string[];
}

/**
 * Copy an agent's whole state dir out of a box, IDENTITY INCLUDED.
 *
 * Two passes, and the split is not an optimization:
 *
 *  1. `pullTree` for the file tree, minus what the agent declared box-specific
 *     and minus every live database.
 *  2. each database through {@link pullSqliteSnapshot}, which uses SQLite's own
 *     online-backup API.
 *
 * Pass 2 exists because a byte copy of a live database is a torn read — the
 * agent-pull module records the measurement that produced a 4 KB `state_5.sqlite`
 * against a 1.79 MB `-wal`. openclaw's gateway state IS such a database, so a
 * one-pass tar would produce a backup that restores into a broken gateway, and
 * would do it silently.
 */
export async function backupAgentState(args: {
  agent: AgentId;
  transport: SyncTransport;
  destDir: string;
}): Promise<AgentStateBackupResult> {
  const spec = resolveAgentSpec(args.agent);
  const boxDir = agentPullBoxDir(args.agent);
  const excluded = [...(spec.stateBackup?.exclude ?? [])];

  await mkdir(args.destDir, { recursive: true });
  await args.transport.pullTree(boxDir, args.destDir, {
    exclude: [...excluded, ...LIVE_DATABASE_EXCLUDES],
  });

  const databases = await backupStateDatabases(args, boxDir, excluded);

  // The capture holds a live gateway token. `~/.agentbox` has always kept
  // extracted credentials at 0600; this is the same secret in a new place.
  await chmod(args.destDir, 0o700).catch(() => {});

  return { databases, excluded };
}

/** Find and snapshot every live database under the agent's state dir. */
async function backupStateDatabases(
  args: { agent: AgentId; transport: SyncTransport; destDir: string },
  boxDir: string,
  excluded: readonly string[],
): Promise<string[]> {
  const prune = excluded.map((e) => `-path ${quote(`./${e}`)} -prune -o`).join(' ');
  // `-name` rather than the exclude globs: those are tar patterns, and this is
  // find. The two lists are the same shapes, spelled for their own tool.
  const found = await args.transport.exec([
    'sh',
    '-c',
    `cd ${quote(boxDir)} 2>/dev/null || exit 0; ` +
      `find . ${prune} \\( -name '*.sqlite' -o -name '*.db' \\) -type f -print 2>/dev/null`,
  ]);
  if (found.exitCode !== 0) return [];

  const rels = found.stdout
    .split('\n')
    .map((l) => l.trim().replace(/^\.\//, ''))
    .filter((l) => l.length > 0);

  const captured: string[] = [];
  for (const rel of rels) {
    const dest = join(args.destDir, rel);
    await mkdir(join(dest, '..'), { recursive: true });
    const ok = await pullSqliteSnapshot(args.transport, `${boxDir}/${rel}`, dest);
    if (ok) {
      captured.push(rel);
      await chmod(dest, 0o600).catch(() => {});
    }
  }
  return captured;
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
