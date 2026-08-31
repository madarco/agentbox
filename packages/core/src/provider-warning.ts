/**
 * A provider log line that must SURVIVE the command it was emitted during.
 *
 * Provider progress reaches the user through `onLog`, which every consumer
 * renders as transient chrome — `prepare` truncates each line into an 80-column
 * spinner frame the next line overwrites a second later, `create` writes to the
 * command log file. That is right for build chatter and wrong for a decision
 * the user needs to know about afterwards: a daytona `linux-vm` bake that finds
 * no published box image silently produces a CONTAINER snapshot, and both the
 * fallback notice and the create-time class mismatch flashed past inside a
 * spinner. The user then had a box with a quarter of the RAM they asked for and
 * nothing on screen said so.
 *
 * So: same channel, marked. Wrap a line in `providerWarning()` and every
 * consumer that understands the marker re-emits it as a persisted warning when
 * the command finishes; one that doesn't still logs it verbatim minus a prefix.
 */
const PROVIDER_WARNING_PREFIX = 'agentbox-warning: ';

/** Mark a line for re-emission after the command's transient output is gone. */
export function providerWarning(text: string): string {
  return `${PROVIDER_WARNING_PREFIX}${text}`;
}

/**
 * A leading ISO-8601 timestamp, which every log transport on the way to a
 * terminal prepends. A queued bake goes provider -> the worker's log file ->
 * the hub API -> the CLI, and the worker stamps each line, so by the time the
 * process that HAS a terminal sees the marker it is no longer at position 0.
 */
const LEADING_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/;

/**
 * The warning text, or null when this is an ordinary progress line.
 *
 * Anchored (after any timestamp) so a build log that merely quotes the marker
 * mid-line stays what it is: build output.
 */
export function parseProviderWarning(line: string): string | null {
  const body = line.replace(LEADING_TIMESTAMP, '');
  return body.startsWith(PROVIDER_WARNING_PREFIX)
    ? body.slice(PROVIDER_WARNING_PREFIX.length)
    : null;
}
