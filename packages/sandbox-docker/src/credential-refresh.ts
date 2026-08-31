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
 * Registry-driven. It used to name three agents in sequence — a claude sync
 * gated on claude's access-token expiry, then a codex extract, then an opencode
 * extract — so a fourth agent got no refresh at all and nothing said so. Each
 * agent now supplies its own step through `AgentSyncModule.refreshHostBackup`,
 * including the expiry gate that is claude's own business (skipping the ~1-2s
 * `docker run` when the token is still fresh).
 */
import type { DockerCredentialRefresher } from '@agentbox/sandbox-core';
import { registeredAgentSyncModules } from './sync/agents/module.js';
import { DEFAULT_BOX_IMAGE } from './image.js';

export const dockerCredentialRefresh: DockerCredentialRefresher = async (opts) => {
  const log = opts.onLog ?? (() => {});
  const image = DEFAULT_BOX_IMAGE;
  // Every registered agent, not three by name. Each decides for itself whether
  // there is anything to do — claude gates on its own token expiry, codex and
  // opencode are extract-only — and an agent that registers no module (or no
  // `refreshHostBackup`) is simply skipped rather than silently mishandled.
  for (const mod of registeredAgentSyncModules()) {
    try {
      await mod.refreshHostBackup?.(image, log);
    } catch {
      /* best-effort: one agent's refresh must never block another's, or a box start */
    }
  }
};
