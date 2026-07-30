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
 * Gated on `hostClaudeBackupExpired`: when the claude backup's `expiresAt` is in
 * the future we skip the docker round-trip entirely (`docker run` against the
 * shared volume is ~1-2s and almost always a noop on fresh tokens).
 */
import { hostClaudeBackupExpired } from '@agentbox/sandbox-core';
import type { DockerCredentialRefresher } from '@agentbox/sandbox-core';
import { DEFAULT_BOX_IMAGE } from './image.js';
import { SHARED_CLAUDE_VOLUME } from './sync/agents/claude.js';
import { SHARED_CODEX_VOLUME } from './sync/agents/codex.js';
import { SHARED_OPENCODE_VOLUME } from './sync/agents/opencode.js';
import {
  extractCodexCredentials,
  extractOpencodeCredentials,
  syncClaudeCredentials,
} from './sync/claude-credentials.js';

export const dockerCredentialRefresh: DockerCredentialRefresher = async (opts) => {
  const log = opts.onLog ?? (() => {});
  if (!(await hostClaudeBackupExpired())) {
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
    await extractCodexCredentials(SHARED_CODEX_VOLUME, image);
  } catch {
    /* best-effort */
  }
  try {
    await extractOpencodeCredentials(SHARED_OPENCODE_VOLUME, image);
  } catch {
    /* best-effort */
  }
};
