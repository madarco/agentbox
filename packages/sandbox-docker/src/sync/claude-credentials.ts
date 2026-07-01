import { chmod, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { execa } from 'execa';
import type { ClaudeConfigSpec } from './agents/claude.js';
import { STATE_DIR } from '../state.js';

// The pure credential guards (`isRealAgentCredential`, `hostClaudeBackupExpired`,
// `hostBackupHasCredentials`) + `CredentialAgentKind` moved to the provider-
// neutral credentials concern in @agentbox/sandbox-core (the per-agent
// real-credential shape is now registry data, `credential.realShape`, shared
// with cloud). Re-exported here so existing docker importers/tests — and the
// `@agentbox/sandbox-docker` barrel — are untouched.
export {
  isRealAgentCredential,
  hostClaudeBackupExpired,
  hostBackupHasCredentials,
  type CredentialAgentKind,
} from '@agentbox/sandbox-core';

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

/** Result line parser for the volume→backup extract helper. Pure (unit-tested). */
export function parseExtractResult(stdout: string): { copied: boolean } {
  return { copied: /\bCOPIED=yes\b/.test(stdout) };
}

/**
 * One-directional extract of a codex/opencode `auth.json` from a shared docker
 * config volume to a host backup under `~/.agentbox` — the cloud analogue of
 * `syncClaudeCredentials`'s extract, used after a host `agentbox <agent> login`
 * so the cloud push can seed the captured login into future boxes. The volume
 * root holds `auth.json` (same convention `volumeHas{Codex,Opencode}Auth` uses
 * for `/dst/auth.json`). Best-effort: any failure resolves to not-copied and
 * never throws into a login flow.
 */
export async function extractVolumeAuthToBackup(opts: {
  volume: string;
  image: string;
  backupFile: string;
}): Promise<{ copied: boolean }> {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    const script =
      'COPIED=no; ' +
      'if [ -s /dst/auth.json ]; then cp -a /dst/auth.json "/host-state/$DEST" && COPIED=yes; fi; ' +
      'echo "COPIED=$COPIED"';
    const { stdout } = await execa('docker', [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${opts.volume}:/dst`,
      '-v',
      `${STATE_DIR}:/host-state`,
      '-e',
      // Pass the destination filename via env so the path isn't interpolated
      // into the script string (keeps the docker arg list static + injection-safe).
      `DEST=${basename(opts.backupFile)}`,
      opts.image,
      'sh',
      '-c',
      script,
    ]);
    const result = parseExtractResult(stdout);
    if (result.copied) await chmod(opts.backupFile, 0o600).catch(() => {});
    return result;
  } catch {
    return { copied: false };
  }
}

/** Extract codex `auth.json` from its shared volume to `~/.agentbox/codex-credentials.json`. */
export function extractCodexCredentials(volume: string, image: string): Promise<{ copied: boolean }> {
  return extractVolumeAuthToBackup({ volume, image, backupFile: CODEX_CREDENTIALS_BACKUP_FILE });
}

/** Extract opencode `auth.json` from its shared volume to `~/.agentbox/opencode-credentials.json`. */
export function extractOpencodeCredentials(volume: string, image: string): Promise<{ copied: boolean }> {
  return extractVolumeAuthToBackup({ volume, image, backupFile: OPENCODE_CREDENTIALS_BACKUP_FILE });
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

export interface VolumeClaudeCredentials {
  /** A `.credentials.json` exists in the shared claude-config volume. */
  present: boolean;
  /** That file carries a usable (non-empty) `claudeAiOauth.refreshToken`. */
  hasRefreshToken: boolean;
}

/**
 * Parse the `PRESENT=<yes|no> REFRESH=<yes|no>` line the probe container prints.
 * Pure — unit-tested independently of docker.
 */
export function parseVolumeClaudeCredentials(stdout: string): VolumeClaudeCredentials {
  return {
    present: /\bPRESENT=yes\b/.test(stdout),
    hasRefreshToken: /\bREFRESH=yes\b/.test(stdout),
  };
}

// Probe the live `.credentials.json` the box actually boots from. `jq` ships in
// the box image; the "usable" test matches SYNC_SCRIPT — a non-empty
// `claudeAiOauth.refreshToken`. A file present with a blanked refreshToken is
// the dead state claude leaves behind after a rejected refresh.
const VOLUME_CRED_PROBE_SCRIPT = `
PRESENT=no
REFRESH=no
VOL=/dst/.credentials.json
if [ -f "$VOL" ]; then
  PRESENT=yes
  if jq -e '(.claudeAiOauth.refreshToken // "") | length > 0' "$VOL" >/dev/null 2>&1; then REFRESH=yes; fi
fi
echo "PRESENT=$PRESENT REFRESH=$REFRESH"
`;

/**
 * Inspect the shared claude-config VOLUME's live `.credentials.json` — the
 * authoritative store the in-box claude reads and refreshes. Unlike the host
 * backup (a mirror that lags and diverges when a refresh fails), this reports
 * what the next box will actually boot with: whether a credentials file exists
 * and whether it still holds a usable refresh token. Used to offer a re-login
 * only when the volume's login is dead (file present, refresh token blanked),
 * not on a merely-stale access token the in-box refresh can renew on its own.
 *
 * Best-effort: an unreadable volume / missing image resolves to
 * `{ present: false, hasRefreshToken: false }` and never throws into a flow.
 */
export async function volumeClaudeCredentials(
  volume: string,
  image: string,
): Promise<VolumeClaudeCredentials> {
  try {
    const { stdout } = await execa('docker', [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${volume}:/dst`,
      image,
      'sh',
      '-c',
      VOLUME_CRED_PROBE_SCRIPT,
    ]);
    return parseVolumeClaudeCredentials(stdout);
  } catch {
    return { present: false, hasRefreshToken: false };
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
