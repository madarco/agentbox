import { UserFacingError } from '@agentbox/core';

/**
 * Top-level CLI error renderer. `UserFacingError` (and anything that
 * advertises itself as one via the `name` field — defends against bundling /
 * dual-publish boundaries dropping the class identity) gets a clean one-line
 * message. Anything else falls through to `console.error` so genuine bugs
 * keep their stack trace for debugging.
 */
export function printCliError(err: unknown, stderr: NodeJS.WritableStream): void {
  if (isUserFacingError(err)) {
    stderr.write(`${err.message}\n`);
    return;
  }
  // Mirror the original top-level catch: `console.error` writes to stderr
  // and prints `.stack` for Error instances.
  const writer = (chunk: string) => stderr.write(chunk);
  writer(formatUnknown(err) + '\n');
}

function isUserFacingError(err: unknown): err is UserFacingError {
  if (err instanceof UserFacingError) return true;
  if (err instanceof Error && err.name === 'UserFacingError') return true;
  return false;
}

function formatUnknown(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}
