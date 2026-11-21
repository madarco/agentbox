/**
 * The text a queue worker logs for a failed job. Usually `err.stack`, but some
 * SDKs replace `stack` with a captured call site (the e2b SDK points a build
 * error at the `template.copy()` that caused it), which drops the message — so
 * the message is prepended whenever the stack doesn't already carry it.
 */
export function failText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const stack = err.stack;
  if (!stack) return err.message;
  return stack.includes(err.message) ? stack : `${err.name}: ${err.message}\n${stack}`;
}
