import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import type { ClaudeConfigSpec } from './claude.js';
import { STATE_DIR } from './state.js';

/**
 * Host-side backup of the in-box Claude Code OAuth credentials.
 *
 * Claude's interactive login (inside a box) writes the only Linux auth file:
 * `~/.claude/.credentials.json`, holding a `claudeAiOauth` block with a real
 * `refreshToken` — that refresh token is what makes claude report "Claude Max"
 * instead of "Claude API". This host backup mirrors that blob so a fresh
 * `--isolate-claude-config` box, or a recreated shared volume, can be seeded
 * with the user's login instead of forcing a re-login.
 *
 * Security: the file holds a live refresh token. It is written mode 0600 under
 * `~/.agentbox/` (already the 0600-convention dir for `auth.json`). Plaintext
 * on disk matches the existing model — the claude-config volume already stores
 * the same blob in the clear; macOS Keychain is the *host* claude's store and
 * is unreachable from a Linux container.
 */
export const CREDENTIALS_BACKUP_FILE = join(STATE_DIR, 'claude-credentials.json');

/**
 * Host-side backups of the in-box codex / opencode auth files, the cloud
 * analogue of {@link CREDENTIALS_BACKUP_FILE} for Claude. Unlike docker (which
 * bind-mounts the host's real `~/.codex` / `~/.config/opencode`), cloud
 * providers have no shared volume, so a login captured inside a cloud box is
 * stored here (by `extractCloudAgentCredentials` on `checkpoint --set-default`)
 * and re-pushed to the next box. The cloud stagers prefer these copies and fall
 * back to the host's real path when absent. Written mode 0600 like the claude
 * backup.
 */
export const CODEX_CREDENTIALS_BACKUP_FILE = join(STATE_DIR, 'codex-credentials.json');
export const OPENCODE_CREDENTIALS_BACKUP_FILE = join(STATE_DIR, 'opencode-credentials.json');

/** Agents whose credentials we extract from a cloud box back to the host. */
export type CredentialAgentKind = 'claude' | 'codex' | 'opencode';

/**
 * True iff `text` looks like a real (usable) credential for `agent`, not an
 * empty/placeholder file. Used so the cloud extraction never clobbers a good
 * host backup with an empty box file. Claude requires a non-empty
 * `claudeAiOauth.refreshToken` (mirrors {@link hostBackupHasCredentials}); codex
 * and opencode auth files just have to parse as a non-empty JSON object.
 */
export function isRealAgentCredential(agent: CredentialAgentKind, text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  if (agent === 'claude') {
    const rt = (parsed as { claudeAiOauth?: { refreshToken?: unknown } }).claudeAiOauth?.refreshToken;
    return typeof rt === 'string' && rt.length > 0;
  }
  return Object.keys(parsed as Record<string, unknown>).length > 0;
}

export type CredentialSyncDirection = 'extracted' | 'seeded' | 'noop';

export interface SyncClaudeCredentialsResult {
  /**
   * `extracted` — the volume's live credentials were copied out to the host
   * backup. `seeded` — the host backup was copied into an empty volume.
   * `noop` — nothing to do (or the best-effort helper failed silently).
   */
  direction: CredentialSyncDirection;
  /**
   * Whether the volume holds a real OAuth blob *after* the sync (true also
   * right after a `seeded`). When false, the in-box claude will fall back to
   * the setup-token / API key, or prompt for an interactive login.
   */
  volumeHasCredentials: boolean;
}

/**
 * True iff the host backup file holds a real OAuth blob (a non-empty
 * `claudeAiOauth.refreshToken`). Used to decide whether to offer an
 * interactive sign-in before creating a box. Tolerant of a missing or
 * garbage file — returns false.
 */
export async function hostBackupHasCredentials(
  path: string = CREDENTIALS_BACKUP_FILE,
): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      claudeAiOauth?: { refreshToken?: unknown };
    };
    const rt = parsed?.claudeAiOauth?.refreshToken;
    return typeof rt === 'string' && rt.length > 0;
  } catch {
    return false;
  }
}

/**
 * Parse the `EXTRACTED=<yes|no> SEEDED=<yes|no> VOLREAL=<yes|no>` line the
 * helper container prints. Pure — unit-tested independently of docker.
 */
export function parseSyncResult(stdout: string): SyncClaudeCredentialsResult {
  const volumeHasCredentials = /\bVOLREAL=yes\b/.test(stdout);
  if (/\bEXTRACTED=yes\b/.test(stdout)) return { direction: 'extracted', volumeHasCredentials };
  if (/\bSEEDED=yes\b/.test(stdout)) return { direction: 'seeded', volumeHasCredentials };
  return { direction: 'noop', volumeHasCredentials };
}

// Bidirectional, best-effort. `jq` ships in the box image. A credentials blob
// only counts as "real" when `claudeAiOauth.refreshToken` is a non-empty
// string — a setup-token blob has an accessToken but no refreshToken, and
// seeding/extracting it would just reproduce the "Claude API" label. The
// final `echo` always runs so the caller can read the outcome; a failed `cp`
// leaves the flag at `no` and the whole thing still exits 0.
const SYNC_SCRIPT = `
EXTRACTED=no
SEEDED=no
VOL=/dst/.credentials.json
HOST=/host-state/claude-credentials.json
if [ -f "$VOL" ] && jq -e '(.claudeAiOauth.refreshToken // "") | length > 0' "$VOL" >/dev/null 2>&1; then VOL_REAL=yes; else VOL_REAL=no; fi
if [ -f "$HOST" ] && jq -e '(.claudeAiOauth.refreshToken // "") | length > 0' "$HOST" >/dev/null 2>&1; then HOST_REAL=yes; else HOST_REAL=no; fi
if [ "$VOL_REAL" = yes ] && [ "$ISOLATE" != yes ]; then
  cp -a "$VOL" "$HOST" && chmod 600 "$HOST" && EXTRACTED=yes
elif [ "$VOL_REAL" = no ] && [ "$HOST_REAL" = yes ]; then
  cp -a "$HOST" "$VOL" && chown 1000:1000 "$VOL" && chmod 600 "$VOL" && SEEDED=yes && VOL_REAL=yes
fi
echo "EXTRACTED=$EXTRACTED SEEDED=$SEEDED VOLREAL=$VOL_REAL"
`;

/**
 * Bidirectionally sync the box's `.credentials.json` with the host backup:
 *
 *  - volume has a real OAuth blob and the box is **not** isolate → copy it OUT
 *    to {@link CREDENTIALS_BACKUP_FILE} (the volume is authoritative — it is
 *    the live copy the in-box claude refreshes).
 *  - volume has no `.credentials.json` and the host backup is real → copy it
 *    IN (seeds a fresh isolate box, or a recreated shared volume).
 *  - otherwise → noop.
 *
 * Isolate boxes are read-seed only — never extract — so N isolate boxes can't
 * race on the single host backup.
 *
 * Best-effort: any failure resolves to `{ direction: 'noop' }` and never
 * throws into a box operation.
 */
export async function syncClaudeCredentials(
  spec: ClaudeConfigSpec,
  opts: { image: string; isolate: boolean },
): Promise<SyncClaudeCredentialsResult> {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    const { stdout } = await execa('docker', [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${spec.volume}:/dst`,
      '-v',
      `${STATE_DIR}:/host-state`,
      '-e',
      `ISOLATE=${opts.isolate ? 'yes' : 'no'}`,
      opts.image,
      'sh',
      '-c',
      SYNC_SCRIPT,
    ]);
    const result = parseSyncResult(stdout);
    // The helper runs as root; re-assert 0600 from the host side so the backup
    // is owner-only regardless of how the bind mount maps ownership.
    if (result.direction === 'extracted') {
      await chmod(CREDENTIALS_BACKUP_FILE, 0o600).catch(() => {});
    }
    return result;
  } catch {
    return { direction: 'noop', volumeHasCredentials: false };
  }
}
