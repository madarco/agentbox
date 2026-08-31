/**
 * One verdict on the saved Claude login, shared by every gate that might ask
 * the user to sign in again.
 *
 * Why it exists: those gates used to read `claudeAiOauth.expiresAt`, which dates
 * the ~8h ACCESS token. On a cloud-only workflow nothing rewrites the host
 * backup between logins, so that field is in the past within a day of every
 * sign-in and stays there — a guaranteed daily "your saved Claude login looks
 * expired" on a login with weeks of life left. Worse, accepting the offer runs a
 * login container that refreshes and ROTATES the shared refresh token before the
 * user touches the browser; the write-back only ran on success, so a cancelled
 * sign-in left the host backup, the control box's backup and its custody copy
 * all holding a spent token. The false alarm made itself true.
 *
 * So: decide on refresh-token health, and when the access token has merely
 * lapsed, actually renew it (`renewClaudeCredential`) instead of guessing. That
 * both silences the nag and hands the next cloud box a fresh token, which is the
 * other half of why the credential kept dying between sessions.
 */
import {
  hostBackupHasCredentials,
  hostClaudeAccessTokenExpired,
  hostClaudeLoginDead,
  imageExists,
  renewClaudeCredential,
} from '@agentbox/sandbox-docker';

/**
 * `ok` — usable (possibly after a silent renewal). `missing` — nothing saved to
 * seed a box with. `dead` — saved, but it can no longer be renewed, so only a
 * fresh sign-in helps.
 */
export type ClaudeCredHealth = 'ok' | 'missing' | 'dead';

export interface ClaudeCredHealthOptions {
  /** Box image the renewal probe runs in. */
  image: string;
  /** Progress lines from the renewal (it can take a few seconds). */
  onProgress?: (line: string) => void;
  /**
   * Skip the renewal probe and answer from the backup alone. The stale-access-
   * token case then answers `ok` — the refresh token is alive and the box can
   * renew it in-box, so there is nothing to warn about.
   */
  offlineOnly?: boolean;
}

export async function resolveClaudeCredHealth(
  opts: ClaudeCredHealthOptions,
): Promise<ClaudeCredHealth> {
  if (!(await hostBackupHasCredentials())) return 'missing';
  if (await hostClaudeLoginDead()) return 'dead';
  if (!(await hostClaudeAccessTokenExpired())) return 'ok';

  // Stale access token, live refresh token. Renewing needs the image locally;
  // don't trigger an implicit pull just to answer a question, and never nag on
  // a host that simply can't run the probe — the refresh token is alive and the
  // box will renew it itself.
  if (opts.offlineOnly === true) return 'ok';
  if (!(await imageExists(opts.image))) return 'ok';

  const renewed = await renewClaudeCredential({
    image: opts.image,
    ...(opts.onProgress ? { onLog: opts.onProgress } : {}),
  });
  return renewed === 'failed' ? 'dead' : 'ok';
}
