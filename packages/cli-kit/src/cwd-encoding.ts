/** In-box absolute workspace path (matches the bind-mount in every provider). */
export const BOX_WORKSPACE = '/workspace';

// `encodeClaudeProjectsDir` and `BOX_WORKSPACE_ENCODED` moved to
// `@agentbox/agent-claude`: the encoding is Claude Code's own
// `~/.claude/projects/<encoded>/` scheme, and its only consumer is claude's
// session teleport. `sandbox-core` keeps a separate copy of the same rule
// (`encodeClaudeProjectsKey`) because it sits below the agent packages and
// cannot import one — that duplication is the layering, not an oversight.
