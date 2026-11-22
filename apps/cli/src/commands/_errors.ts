import { HubApiError } from '../control-plane/hub-api-client.js';
import { hubUnauthorizedHint } from '../control-plane/unauthorized-hint.js';
import { log } from '@clack/prompts';
import { AmbiguousBoxError, BoxNotFoundError } from '@agentbox/sandbox-docker';
import { ClaudeSessionError } from '@agentbox/agent-claude';

/**
 * Map common lifecycle errors to user-facing messages and the right exit code,
 * then exit. Shared by all lifecycle commands so error UX stays consistent.
 */
export function handleLifecycleError(err: unknown): never {
  if (err instanceof BoxNotFoundError) {
    log.error(err.message);
    log.info('Run `agentbox list` to see available boxes.');
    process.exit(2);
  }
  if (err instanceof AmbiguousBoxError) {
    log.error(err.message);
    log.info('Specify more characters of the id, or use the full name.');
    process.exit(2);
  }
  if (err instanceof ClaudeSessionError) {
    log.error(err.message);
    process.exit(2);
  }
  const msg = err instanceof Error ? err.message : String(err);
  log.error(msg);
  // Any command that reached a hub and got a 401: say why and what to run, the
  // same advice `ls` and the relay give (a revoked or never-enrolled computer).
  if (err instanceof HubApiError && err.status === 401) {
    const url = process.env.AGENTBOX_CONTROL_PLANE_URL;
    log.info(hubUnauthorizedHint(url, url ? 'remote' : 'local'));
  }
  process.exit(1);
}
