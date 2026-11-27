const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * Whether a user row's text is a harness injection rather than something a
 * person typed: a background task's `<task-notification>`, a harness
 * `<wake …>`, or nothing but `<system-reminder>` blocks
 * (docs/usage-dashboard-plan.md, "Busy spans").
 */
export function isInjectedPrompt(text: string): boolean {
  const t = text.trim();
  if (t.startsWith('<task-notification>') || t.startsWith('<wake ')) return true;
  if (!t.startsWith('<system-reminder>')) return false;
  // A stored text is clipped, so the last block may have lost its closing tag.
  const rest = t.replace(REMINDER, '').trim();
  return rest === '' || rest.startsWith('<system-reminder>');
}
