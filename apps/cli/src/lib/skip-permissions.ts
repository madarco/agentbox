/**
 * The "skip permission prompts" injection, as a mechanism with no agent in it.
 *
 * A box is an isolated sandbox, so auto-accepting tool use removes friction the
 * box already makes safe — hence the per-agent config key defaults to on (see
 * BUILT_IN_DEFAULTS in @agentbox/config).
 *
 * Applied at the command layer (where the effective config is resolved) to the
 * arg array that flows to BOTH the docker session start (`start<Agent>Session`)
 * and the cloud attach (`extraArgs` -> `buildCloudAttachInnerCommand`), so one
 * call covers every provider.
 *
 * WHICH flag, and which user args count as "the user already decided", is data
 * that belongs to the agent: it lives on that agent's runtime
 * (`AgentRuntime.skipPermissions`), which is `null` for an agent that has no
 * such flag at all — OpenCode. Nothing here knows an agent's name, so a new
 * agent supplies a rule and gets this behavior with no edit to this file.
 */

/** One agent's bypass flag and the user args that mean "don't inject". */
export interface SkipPermissionsRule {
  /** The flag to prepend. */
  readonly flag: string;
  /**
   * Args that already govern the same surface. Their presence means the user
   * made an explicit choice, which always wins over the config default.
   */
  readonly conflictingArgs: readonly string[];
}

/**
 * Prepend `rule.flag` unless the user already passed something that governs the
 * same surface, or the config disabled it.
 */
export function applySkipPermissions(
  args: string[],
  rule: SkipPermissionsRule,
  enabled: boolean,
): string[] {
  if (!enabled) return args;
  const conflicting = new Set(rule.conflictingArgs);
  // Match both `--permission-mode plan` and `--permission-mode=plan` — the flag
  // name is everything before the first `=` when the user uses inline syntax.
  const hasConflict = args.some((a) => {
    const eq = a.indexOf('=');
    return conflicting.has(eq === -1 ? a : a.slice(0, eq));
  });
  if (hasConflict) return args;
  return [rule.flag, ...args];
}
