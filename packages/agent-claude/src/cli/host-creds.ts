/**
 * Claude's host-side credential check, for the pre-flight that runs before a
 * detached `-i` job. Beside the runtime that owns it — the shared queue helper
 * used to hold this and codex's and opencode's, dispatching between them with a
 * three-arm chain that a fourth agent fell through silently.
 */
import { hostBackupHasCredentials } from '@agentbox/sandbox-docker';
import { resolveClaudeAuth } from './auth.js';
import { resolveClaudeCredHealth, type ClaudeCredHealthOptions } from './cred-health.js';

/**
 * True when Claude is already authenticated on the host: a forwarded env var
 * (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`), the legacy
 * `~/.agentbox/auth.json` setup-token, or a real OAuth refresh token in the
 * host backup (`~/.agentbox/claude-credentials.json`). The backup is what the
 * foreground sync writes whenever a box's claude logs in, so its presence is
 * the load-bearing signal that the shared volume has been seeded.
 */
export async function claudeAuthAvailable(env: NodeJS.ProcessEnv): Promise<boolean> {
  const resolved = await resolveClaudeAuth(env);
  if (resolved.source !== 'none') return true;
  return hostBackupHasCredentials();
}

/**
 * Richer Claude credential verdict for the non-interactive paths. `'missing'`
 * when nothing can seed a box; `'expired'` when the saved login can no longer be
 * renewed AND we're on a cloud provider — cloud has no shared volume to fall
 * back to, whereas a docker box boots from the volume's live copy and refreshes
 * it in-box. A host-env token (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`)
 * or legacy `auth.json` short-circuits to `'ok'`: it has no expiry concept here.
 * Mirrors the interactive `maybeRunCloudClaudeLogin` split, and shares its
 * verdict helper — so a merely-lapsed access token is renewed here too rather
 * than failing the job. This used to gate on `expiresAt` (the ~8h access token)
 * and so refused to submit perfectly good jobs every day.
 */
export async function claudeCredStatus(
  env: NodeJS.ProcessEnv,
  isCloud: boolean,
  image?: string,
  /** Forwarded to {@link resolveClaudeCredHealth}; see its `probes`. */
  probes?: ClaudeCredHealthOptions['probes'],
): Promise<'ok' | 'missing' | 'expired'> {
  const resolved = await resolveClaudeAuth(env);
  if (resolved.source !== 'none') return 'ok';
  if (!isCloud) {
    const has = probes?.hostBackupHasCredentials ?? hostBackupHasCredentials;
    return (await has()) ? 'ok' : 'missing';
  }
  const health = await resolveClaudeCredHealth({
    image: image ?? '',
    // No image to probe with means no renewal; answer off the backup alone.
    ...(image === undefined ? { offlineOnly: true } : {}),
    ...(probes ? { probes } : {}),
  });
  if (health === 'missing') return 'missing';
  return health === 'dead' ? 'expired' : 'ok';
}
