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
  process.exit(1);
}
