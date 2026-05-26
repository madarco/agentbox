import { resolveAgentLauncher, type AgentKind } from '@agentbox/core';

/**
 * Build the argv the in-box agent CLI is launched with, slotting `prompt` as
 * the first positional so claude/codex/opencode all pick it up as the seed
 * user turn. Mirrors what the setup-wizard path already does in claude.ts;
 * lifted here so the three commands and the queued worker all agree on the
 * shape. Empty prompt is a no-op — userArgs are returned as-is.
 */
export function buildPromptArgs(
  agentKind: AgentKind,
  prompt: string,
  userArgs: string[],
): string[] {
  return resolveAgentLauncher(agentKind).buildArgs(prompt, userArgs);
}
