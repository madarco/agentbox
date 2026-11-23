import { resolveAgentLauncher, type QueueAgentKind } from '@agentbox/core';
import { findAgentSpec } from '@agentbox/sandbox-core';

/**
 * Build the argv the in-box agent CLI is launched with, seeding `prompt` as the
 * first user turn in the shape the agent's registry row declares (a leading
 * positional, or behind its `seedPromptFlag`). Shared by the agent commands
 * and the queued worker so they all agree on the shape. Empty prompt is a
 * no-op — userArgs are returned as-is.
 */
export function buildPromptArgs(
  agentKind: QueueAgentKind,
  prompt: string,
  userArgs: string[],
): string[] {
  return resolveAgentLauncher(agentKind, findAgentSpec(agentKind)).buildArgs(prompt, userArgs);
}
