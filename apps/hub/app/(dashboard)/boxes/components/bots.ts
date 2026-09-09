/**
 * The bot-backup shapes the box pages read from `GET /projects/{id}/bots`, and
 * the two rules every consumer of them has to get right.
 *
 * Shared because three components read this listing — the create modal's
 * Start-from row, the box page's "last backed up" line, and the project page's
 * card — and a fourth copy of "which backups can actually restore this bot" is
 * exactly the kind of drift that ends with a UI offering one that cannot.
 */

export interface BotBackup {
  stamp: string;
  agent?: string;
  /**
   * False when the bundle captured only a workspace. Restoring one gives a
   * working box with a FRESH identity, which is what clone already does — the
   * hub's restore route refuses it, so no UI may offer it.
   */
  state: boolean;
  boxName?: string;
  provider?: string;
}

export interface BotBackups {
  bot: string;
  /** The stamp `latest` resolves to; absent when the link is missing or dangling. */
  latest?: string;
  backups: BotBackup[];
}

/** The backups that carry an identity, newest first (the API's own order). */
export function restorableBackups(bot: BotBackups): BotBackup[] {
  return bot.backups.filter((b) => b.state);
}

/** The one a restore should default to: `latest` when restorable, else the newest that is. */
export function preferredBackup(bot: BotBackups): BotBackup | undefined {
  const restorable = restorableBackups(bot);
  return restorable.find((b) => b.stamp === bot.latest) ?? restorable[0];
}

/**
 * `2026-09-09T20-48-33Z` as something a human reads.
 *
 * The stamp's `-` separators in the time are what make it a portable directory
 * name; they are also what stops `Date` parsing it, hence the rewrite.
 */
export function readableStamp(stamp: string): string {
  const iso = stamp.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/, '$1T$2:$3:$4Z');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? stamp : d.toLocaleString();
}

/**
 * Joins a bot to a stamp for one `<option value>`.
 *
 * A backup is identified by BOTH halves, which is why the Start-from row is one
 * select rather than a bot picker plus a backup picker: splitting them made the
 * common case — one bot, one recent backup — two decisions where there is none.
 * `/` is safe as the separator because a bot name is validated as a single path
 * segment and a stamp is generated, so neither half can contain one.
 */
export const RESTORE_KEY_SEP = '/';

export function restoreKeyOf(bot: string, stamp: string): string {
  return `${bot}${RESTORE_KEY_SEP}${stamp}`;
}

export function parseRestoreKey(key: string): { bot: string; stamp: string } | null {
  const parts = key.split(RESTORE_KEY_SEP);
  return parts.length === 2 && parts[0] && parts[1] ? { bot: parts[0], stamp: parts[1] } : null;
}
