/**
 * Claude Code encodes the working-directory absolute path into the
 * `~/.claude/projects/<encoded>/` directory name by replacing every
 * non-alphanumeric character with `-`. E.g. `/Users/marco/Projects/foo` →
 * `-Users-marco-Projects-foo`; `/Users/marco/.agents/skills` →
 * `-Users-marco--agents-skills` (the dot AND the slash both become `-`).
 */
export function encodeClaudeProjectsDir(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Encoded form of `/workspace` — the in-box project key for any AgentBox sandbox. */
export const BOX_WORKSPACE_ENCODED = encodeClaudeProjectsDir('/workspace');

/** In-box absolute workspace path (matches the bind-mount in every provider). */
export const BOX_WORKSPACE = '/workspace';
