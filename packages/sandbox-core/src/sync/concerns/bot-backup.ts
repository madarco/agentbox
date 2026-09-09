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
import { join, sep } from 'node:path';
import type { Dirent } from 'node:fs';
import type { AgentId, BoxRecord, SyncTransport } from '@agentbox/core';
import { LIVE_DATABASE_EXCLUDES } from '@agentbox/core';
import { findAgentSpec, resolveAgentSpec } from '../registry.js';
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

/**
 * What {@link backupStamp} produces, and the only directory name under a bot
 * that IS a backup.
 *
 * Matched rather than assumed, because the bot dir is not backups-only: a
 * restore writes its live `workspace/` tree there as a sibling of the stamps.
 * Treating "any dir that is not `latest`" as a backup would let that tree take a
 * slot in the prune's ordering and, since `workspace` sorts after every stamp,
 * silently make it the newest "backup" nothing may delete.
 */
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

/** `<project>/.agentbox/bots/<bot>`. */
export function botDir(projectRoot: string, bot: string): string {
  return join(projectRoot, BOTS_DIR_REL, bot);
}

/**
 * Where a bot spawned from this box should live: a sibling of the source bot
 * under the SAME project, `<project>/.agentbox/bots/<name>/workspace`.
 *
 * Decision 7 of the bot plan — the project is the template and its bots are
 * instances of it, so they share one tree and one `.gitignore` entry instead of
 * scattering under `~/.agentbox/clones/`. A box with no project root (one
 * created from a bare directory) keeps the old home-dir default, which is the
 * only answer available.
 *
 * The trailing-segment strip is what stops bots nesting: a box created BY a
 * restore or a clone already runs on `.../.agentbox/bots/<x>/workspace`, and
 * cloning that one must produce a sibling of `<x>`, not
 * `.../bots/<x>/workspace/.agentbox/bots/<y>/workspace`.
 */
export function botWorkspaceRoot(projectRoot: string): string {
  const parts = projectRoot.split(sep);
  const n = parts.length;
  if (
    n >= 4 &&
    parts[n - 1] === 'workspace' &&
    parts[n - 3] === 'bots' &&
    parts[n - 4] === '.agentbox'
  ) {
    return parts.slice(0, n - 4).join(sep);
  }
  return projectRoot;
}

/** `<project>/.agentbox/bots/<bot>/<stamp>`. */
export function botBackupDir(projectRoot: string, bot: string, stamp: string): string {
  return join(botDir(projectRoot, bot), stamp);
}

/** How many backups a bot keeps before the oldest are pruned. */
export const DEFAULT_BACKUP_KEEP = 3;

/** Where one backup goes, and what it will capture. */
export interface BackupTarget {
  /** The project the bundle is written under. */
  projectRoot: string;
  bot: string;
  stamp: string;
  /** `<project>/.agentbox/bots/<bot>/<stamp>`. */
  dir: string;
  /** Where the workspace half lands. */
  workspaceDir: string;
  keep: number;
  /** The agent whose state to capture; absent when the box has no known one. */
  agent?: AgentId;
}

/** What a caller may say about a backup. `keep` is a string so a CLI flag and a
 * JSON body reach the same validator. */
export interface BackupTargetOptions {
  name?: string;
  keep?: string | number;
  agent?: string;
}

/**
 * Resolve where this backup goes and what it will capture.
 *
 * `projectRoot ?? workspacePath` is the fallback the hub already uses: the field
 * is absent on records made before it existed, and a backup must not silently
 * pick a different directory for an old box.
 *
 * Shared with the hub deliberately — a route that resolved the bundle path its
 * own way would be a second definition of "where a bot's backups live", and the
 * CLI's `--restore` reads back what either of them wrote.
 */
export function resolveBackupTarget(box: BoxRecord, opts: BackupTargetOptions): BackupTarget {
  const projectRoot = box.projectRoot ?? box.workspacePath;
  const bot = (opts.name ?? box.name).trim();
  if (bot.length === 0 || bot.includes('/') || bot === '.' || bot === '..') {
    throw new Error(`--name ${opts.name ?? ''}: a bot name must be a single path segment`);
  }

  const keep =
    opts.keep === undefined
      ? DEFAULT_BACKUP_KEEP
      : typeof opts.keep === 'number'
        ? opts.keep
        : Number.parseInt(opts.keep, 10);
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`--keep ${String(opts.keep ?? '')}: expected a positive integer`);
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
 * Create the bundle's directories before anything writes into them.
 *
 * rsync creates the LAST component of its destination and no more, so a fresh
 * `<project>/.agentbox/bots/<bot>/<stamp>/workspace` is several levels too deep
 * for it and the transfer dies with "No such file or directory". The CLI's
 * dry-run pass hits it too, so this cannot wait until the write.
 */
export async function prepareBackupDir(target: BackupTarget): Promise<void> {
  await mkdir(target.workspaceDir, { recursive: true });
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

/**
 * The backup directory names under `<bot>`, newest first.
 *
 * Stamp-shaped names only ({@link STAMP_RE}) — `latest` and a restore's live
 * `workspace/` are siblings, not backups.
 */
export async function listBackups(projectRoot: string, bot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(botDir(projectRoot, bot));
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of entries) {
    if (!STAMP_RE.test(name)) continue;
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

/** A bundle resolved on disk, ready to restore from. */
export interface BotBundle {
  /** `<project>/.agentbox/bots/<bot>/<stamp>`. */
  dir: string;
  bot: string;
  stamp: string;
  manifest: BackupManifest;
  /** The workspace half. */
  workspaceDir: string;
  /** The state half; absent when the backup captured only the workspace. */
  stateDir?: string;
}

/** Read and shape-check a bundle's manifest. */
export async function readBackupManifest(dir: string): Promise<BackupManifest> {
  const path = join(dir, 'manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `${path}: not a readable backup manifest (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const m = parsed as Partial<BackupManifest>;
  // Version first: a bundle from a newer AgentBox may hold a layout this code
  // would half-restore, and half a bot is worse than a refusal.
  if (m.version !== 1) {
    throw new Error(
      `${path}: manifest version ${String(m.version)} is not one this build restores`,
    );
  }
  if (typeof m.bot !== 'string' || typeof m.stamp !== 'string') {
    throw new Error(`${path}: manifest is missing 'bot' or 'stamp'`);
  }
  return m as BackupManifest;
}

/**
 * Resolve which backup of `bot` to restore.
 *
 * `stamp` absent follows the `latest` symlink, and falls back to the newest
 * stamped dir when the link is missing — a bundle copied with a tool that drops
 * symlinks is still restorable, which is the whole point of a relative link.
 */
export async function resolveBotBundle(
  projectRoot: string,
  bot: string,
  stamp?: string,
): Promise<BotBundle> {
  const base = botDir(projectRoot, bot);
  let chosen = stamp;
  if (!chosen) {
    chosen = (await readlink(join(base, 'latest')).catch(() => null)) ?? undefined;
    if (chosen === undefined) chosen = (await listBackups(projectRoot, bot))[0];
  }
  if (!chosen) {
    throw new Error(
      `no backup of '${bot}' under ${base} — run \`agentbox download --backup\` first`,
    );
  }
  const dir = join(base, chosen);
  const manifest = await readBackupManifest(dir);
  const workspaceDir = join(dir, 'workspace');
  if (!(await lstat(workspaceDir).catch(() => null))?.isDirectory()) {
    throw new Error(`${dir}: the backup has no workspace/ directory`);
  }
  const stateDir = join(dir, 'state');
  const hasState = (await lstat(stateDir).catch(() => null))?.isDirectory() === true;
  return {
    dir,
    bot: manifest.bot,
    stamp: chosen,
    manifest,
    workspaceDir,
    ...(hasState ? { stateDir } : {}),
  };
}

export interface AgentStateRestoreResult {
  /** Box paths whose stale write-ahead log / shared-memory file was removed. */
  clearedSidecars: string[];
}

/**
 * Push a captured state dir back into a box, IDENTITY INCLUDED — the inverse of
 * {@link backupAgentState}.
 *
 * The caller must have stopped the agent first. Two things this does that a
 * plain "copy the directory in" does not, both of them load-bearing:
 *
 * 1. **The stale write-ahead logs go first.** MEASURED, and it is not a corner
 *    case: a fresh openclaw box has already onboarded, so its `state/` holds a
 *    live `openclaw.sqlite` with its own `-wal`/`-shm`. Copying the backup's
 *    main file over it leaves that WAL in place, pointing at a database it no
 *    longer describes, and the gateway then refuses to start —
 *    `SQLite integrity_check failed … row 1 missing from index` — in a restart
 *    loop. Only the sidecars of a database the bundle actually replaces are
 *    removed: one belonging to a database we are not overwriting may hold the
 *    only copy of committed rows.
 * 2. **Modes are preserved** (`noSamePerms` left off), because the gateway token
 *    file is 0600 and a restore that widened it would be a downgrade the user
 *    never asked for.
 *
 * NOT routed through `agentPushExcludes`: that helper adds
 * `LIVE_DATABASE_EXCLUDES` unconditionally, which matches `*.sqlite*` — exactly
 * the gateway state a restore exists to put back. The bundle was already
 * filtered when it was captured.
 */
export async function restoreAgentState(args: {
  agent: AgentId;
  transport: SyncTransport;
  srcDir: string;
}): Promise<AgentStateRestoreResult> {
  const boxDir = agentPullBoxDir(args.agent);
  const clearedSidecars = await clearStaleSidecars(args, boxDir);
  await args.transport.pushTree(args.srcDir, boxDir);
  return { clearedSidecars };
}

/** Remove the box's `-wal`/`-shm` for every database this bundle replaces. */
async function clearStaleSidecars(
  args: { transport: SyncTransport; srcDir: string },
  boxDir: string,
): Promise<string[]> {
  const rels = await findLocalDatabases(args.srcDir);
  if (rels.length === 0) return [];
  const paths = rels.flatMap((rel) => [`${boxDir}/${rel}-wal`, `${boxDir}/${rel}-shm`]);
  const r = await args.transport.exec(['sh', '-c', `rm -f ${paths.map(quote).join(' ')}`]);
  // FAIL, do not continue. `rm -f` is silent about a file that was not there, so
  // a non-zero exit means the removal itself did not happen — and pushing the
  // databases anyway lands them on the leftover logs, which is precisely the
  // integrity-check restart loop this step exists to prevent. A restore that
  // stops here leaves a box with its own working identity; one that continues
  // leaves a box that never boots.
  if (r.exitCode !== 0) {
    throw new Error(
      `could not clear stale write-ahead logs under ${boxDir}: ` +
        `${r.stderr.trim() || `exit ${String(r.exitCode)}`}`,
    );
  }
  return paths;
}

/** Host-side twin of the backup's `find`: the databases the bundle carries. */
async function findLocalDatabases(root: string, prefix = ''): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = prefix ? join(prefix, e.name) : e.name;
    if (e.isDirectory()) out.push(...(await findLocalDatabases(root, rel)));
    else if (e.isFile() && (e.name.endsWith('.sqlite') || e.name.endsWith('.db'))) out.push(rel);
  }
  return out;
}
