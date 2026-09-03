/**
 * Claude's host-backup health guards.
 *
 * These read `~/.agentbox/claude-credentials.json` and answer two different
 * questions about it — "worth renewing?" and "dead?" — both of which are only
 * meaningful for a `claude-oauth` blob. They lived in
 * `sandbox-core/src/sync/concerns/credentials.ts`, a layer that must not know
 * about a specific agent; their only consumer was already in this package.
 *
 * The OAuth field PARSERS stayed behind, renamed for the shape rather than the
 * agent (`oauthRefreshExpiresAt`): the generic credential-accept gate needs them
 * too, and it reaches them by dispatching on `credential.realShape`.
 */

import { readFile } from 'node:fs/promises';
import {
  isRealAgentCredential,
  oauthRefreshExpiresAt,
  resolveAgentSpec,
} from '@agentbox/sandbox-core';
import { requireAgentCredential } from '@agentbox/core';

const CLAUDE_HOST_BACKUP = requireAgentCredential(resolveAgentSpec('claude')).hostBackup;

/**
 * True iff the claude host backup's *access* token has lapsed
 * (`claudeAiOauth.expiresAt`, ms epoch, < now). Access tokens live ~8h, so this
 * is true of a perfectly healthy login most of the time — it answers "is this
 * blob worth renewing before we hand it to a box?", NOT "is this login dead?".
 * For that, see {@link hostClaudeLoginDead}.
 *
 * A missing `expiresAt` (or unreadable file) → false: we only report a *known*
 * lapse. `now` is injectable for tests. Claude is the only agent with a
 * token-expiry field (codex / opencode auth files carry no comparable one).
 */
export async function hostClaudeAccessTokenExpired(
  path: string = CLAUDE_HOST_BACKUP,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      claudeAiOauth?: { expiresAt?: unknown };
    };
    const exp = parsed?.claudeAiOauth?.expiresAt;
    return typeof exp === 'number' && Number.isFinite(exp) && exp < now;
  } catch {
    return false;
  }
}

/**
 * True iff the saved claude login can no longer be renewed: no usable refresh
 * token at all, or the refresh token's own ~30-day life
 * (`claudeAiOauth.refreshTokenExpiresAt`) has run out.
 *
 * This is the question every "should we ask the user to sign in again?" gate
 * actually wants. Gating those on the access token instead produced a daily
 * false alarm — and accepting that alarm runs a login container that refreshes
 * and ROTATES the shared token before the user types anything, so a cancelled
 * sign-in left every copy of the login (host backup, custody, other boxes)
 * holding a spent token. A merely-lapsed access token renews itself.
 *
 * A missing `refreshTokenExpiresAt` → not dead, matching the "only report a
 * *known* death" convention of {@link hostClaudeAccessTokenExpired}: an older
 * blob that predates the field must not be declared dead on a guess. Note this
 * cannot see a token that was rotated away by another copy — that is only
 * observable by trying to use it.
 */
export async function hostClaudeLoginDead(
  path: string = CLAUDE_HOST_BACKUP,
  now: number = Date.now(),
): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return false;
  }
  if (!isRealAgentCredential('claude', text)) return true;
  const exp = oauthRefreshExpiresAt(text);
  return exp !== null && exp < now;
}
