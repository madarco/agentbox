const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * Whether a user row's text is a harness injection rather than something a
 * person typed: a background task's `<task-notification>`, or nothing but
 * `<system-reminder>` blocks. The fallback for transcripts that carry no
 * origin of their own (docs/usage-dashboard-plan.md, "Busy spans").
 */
export function isInjectedPrompt(text: string): boolean {
  const t = text.trim();
  if (t.startsWith('<task-notification>')) return true;
  return t.startsWith('<system-reminder>') && t.replace(REMINDER, '').trim() === '';
}
