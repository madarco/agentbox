/**
 * Claude Code encodes the working-directory absolute path into the
 * `~/.claude/projects/<encoded>/` directory name by replacing every
 * non-alphanumeric character with `-`. E.g. `/Users/marco/Projects/foo` →
 * `-Users-marco-Projects-foo`; `/Users/marco/.agents/skills` →
 * `-Users-marco--agents-skills` (the dot AND the slash both become `-`).
 *
 * Lived in `@agentbox/cli-kit`, the shared CLI kit — but this is Claude Code's
 * own on-disk scheme and claude's session teleport is its only consumer.
 * `sandbox-core` keeps its own copy of the same rule (`encodeClaudeProjectsKey`)
 * because it sits below the agent packages and cannot import one.
 */
export function encodeClaudeProjectsDir(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Encoded form of `/workspace` — the in-box project key for any AgentBox sandbox. */
export const BOX_WORKSPACE_ENCODED = encodeClaudeProjectsDir('/workspace');

/**
 * In-box `~/.claude/plans/` directory (vscode user home).
 *
 * `agentbox claude --plan` uploads a host plan file here. It lived in
 * `apps/cli/src/session-teleport/plan.ts`, which is otherwise generic teleport
 * plumbing — the DESTINATION is claude's, so it sits with claude.
 */
export const BOX_CLAUDE_PLANS_DIR = '/home/vscode/.claude/plans';
