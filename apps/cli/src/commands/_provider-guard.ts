import { log } from '@clack/prompts';
import type { BoxRecord } from '@agentbox/core';

/**
 * Bail out with a clear, actionable error when a Docker-specific command is
 * invoked against a non-Docker box. Use this in commands whose internals
 * (`docker exec`, named volumes, in-box tmux session probing, etc.) haven't
 * been re-implemented for the provider abstraction yet — better to fail fast
 * with a hint than to surface a confusing docker-not-found stack.
 *
 * Returns when the box is Docker-backed; calls `process.exit(2)` otherwise.
 */
export function requireDockerProvider(box: BoxRecord, commandName: string): void {
  const provider = box.provider ?? 'docker';
  if (provider === 'docker') return;
  log.error(
    `\`agentbox ${commandName}\` doesn't yet support cloud boxes (this box's provider is '${provider}').`,
  );
  log.info(
    "Cloud-provider routing for this command is on the Phase 3 backlog. For now: use `agentbox url` for web access, `agentbox-ctl git push` from inside the sandbox via SSH/web terminal, or fall back to the cloud provider's own console.",
  );
  process.exit(2);
}
