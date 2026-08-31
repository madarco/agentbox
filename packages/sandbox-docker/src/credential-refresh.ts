/**
 * The docker-side refresh the cloud create path calls through the
 * `@agentbox/sandbox-core` `credential-refresh.ts` seam: extract the freshest
 * agent tokens from the live docker shared credential volumes into the host
 * backups (`~/.agentbox/{claude,codex,opencode}-credentials.json`) before a
 * cloud create seeds a box from them.
 *
 * Why it exists: `agentbox create --provider <cloud>` reads the host backups to
 * seed cloud boxes, but only the docker create path keeps them current
 * (`syncClaudeCredentials` runs at `create.ts`). Without this refresh, cloud
 * creates push whatever access token the docker volume last extracted — often
 * expired by the time the user actually attaches → in-box `claude` says "401
 * Invalid authentication credentials" even though the box's `.credentials.json`
 * is present.
 *
 * The CLI installs this into the seam at startup; a docker-free host never does,
 * so the cloud seed there just uses the existing backup. Best-effort: every
 * helper swallows its own failures (no docker, missing volume) and returns a
 * noop result.
 *
 * Gated on `hostClaudeAccessTokenExpired`: when the claude backup's access token
 * is still valid we skip the docker round-trip entirely (`docker run` against
 * the shared volume is ~1-2s and almost always a noop on fresh tokens). That is
 * the one place the access-token check belongs — it asks "is this blob worth
 * refreshing?", not "is this login dead?".
 */
import { hostClaudeAccessTokenExpired,
  resolveAgentSpec,
} from '@agentbox/sandbox-core';
import type { DockerCredentialRefresher } from '@agentbox/sandbox-core';
import { DEFAULT_BOX_IMAGE } from './image.js';
import { SHARED_CLAUDE_VOLUME, warmUpClaudeCredentials } from './sync/agents/claude.js';
import {
  extractCodexCredentials,
  extractOpencodeCredentials,
  syncClaudeCredentials,
} from './sync/claude-credentials.js';

export const dockerCredentialRefresh: DockerCredentialRefresher = async (opts) => {
  const log = opts.onLog ?? (() => {});
  if (!(await hostClaudeAccessTokenExpired())) {
    return;
  }
  log('claude: host credentials backup expired — refreshing from docker shared volume');
  const image = DEFAULT_BOX_IMAGE;
  try {
    const r = await syncClaudeCredentials(
      { volume: SHARED_CLAUDE_VOLUME },
      { image, isolate: false },
    );
    if (r.direction === 'extracted') {
      log('claude: refreshed host credentials backup from docker shared volume');
    } else if (r.direction === 'noop') {
      log('claude: no docker shared volume to refresh from (continuing with existing backup)');
    }
  } catch {
    /* best-effort — syncClaudeCredentials already swallows internally */
  }
  // codex + opencode are extract-only (no docker bind mount of the host's real
  // ~/.codex into the box like claude has), so always try when the docker
  // volume exists. Both helpers return { copied: false } on any error.
  try {
    await extractCodexCredentials(resolveAgentSpec('codex').dockerVolume, image);
  } catch {
    /* best-effort */
  }
  try {
    await extractOpencodeCredentials(resolveAgentSpec('opencode').dockerVolume, image);
  } catch {
    /* best-effort */
  }
};

/** Outcome of {@link renewClaudeCredential}. */
export type RenewClaudeResult = 'renewed' | 'unchanged' | 'failed';

/**
 * Actively renew the saved claude login through the shared docker volume, and
 * report whether it still works.
 *
 * A credential's health is not readable off disk: `expiresAt` only dates the
 * ~8h access token, and a refresh token that was rotated away by another copy
 * looks perfectly valid until you try it. The only honest test is to use it —
 * so drive the same pair the successful-login path runs in its `finalize`:
 *
 *  1. `syncClaudeCredentials` — converge volume and backup on the newer blob,
 *     so we renew from the freshest copy rather than whichever the volume holds.
 *  2. `warmUpClaudeCredentials` — a headless `claude -p` forces a real OAuth
 *     refresh, minting a fresh access token into the volume.
 *  3. `syncClaudeCredentials` again — extract that fresh blob to the host backup
 *     so the cloud seed (and every later box) gets a live credential.
 *
 * This is what keeps the fleet logged in without nagging: a lapsed access token
 * is renewed silently, and only a genuine failure — `'failed'` — is worth
 * asking the user to sign in again for.
 *
 * `attempts` is deliberately small (2 by default): the login path's 6 exist to
 * outwait the fresh-token first-request 400, but on the create path every extra
 * attempt costs the user 5s + a container start before we can say "dead".
 *
 * Best-effort: any docker failure resolves to `'failed'`, never throws.
 */
export async function renewClaudeCredential(opts: {
  image?: string;
  attempts?: number;
  onLog?: (msg: string) => void;
}): Promise<RenewClaudeResult> {
  const log = opts.onLog ?? (() => {});
  const image = opts.image ?? DEFAULT_BOX_IMAGE;
  try {
    await syncClaudeCredentials({ volume: SHARED_CLAUDE_VOLUME }, { image, isolate: false });
    const warm = await warmUpClaudeCredentials(SHARED_CLAUDE_VOLUME, image, {
      attempts: opts.attempts ?? 2,
      onProgress: (line) => {
        log(line);
      },
    });
    if (!warm.warmed) {
      log('claude: saved login did not renew — it may have been rotated away by another box');
      return 'failed';
    }
    const synced = await syncClaudeCredentials(
      { volume: SHARED_CLAUDE_VOLUME },
      { image, isolate: false },
    );
    return synced.direction === 'extracted' ? 'renewed' : 'unchanged';
  } catch {
    return 'failed';
  }
}
