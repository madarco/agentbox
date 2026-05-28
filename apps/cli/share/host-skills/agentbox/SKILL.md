---
name: agentbox
description: "Fork the current agent session into a new VM or local Docker container with all the project files, agent settings and session teleported into."
disable-model-invocation: true
context: fork
agent: general-purpose
allowed-tools: Bash
---
<!-- agentbox-managed:v1 -->

Fork the current Claude Code session into a fresh AgentBox box.

1. **Resolve the provider flag from `$ARGUMENTS`:**
   - empty → no flag (uses the default docker provider)
   - `docker` | `daytona` | `hetzner` → pass `--provider $ARGUMENTS`
   - anything else → stop and tell the user the valid values are `docker`, `daytona`, `hetzner`

2. **Fork.** Run, via the Bash tool, exactly one command:

   ```
   agentbox fork --session ${CLAUDE_SESSION_ID} [--provider $ARGUMENTS]
   ```

3. **Report.** In one line, give the user the new box name (parse it from the command output) and confirm their host session is unaffected. Do not summarize the conversation — the fork already carries it.

## Troubleshooting

- If agentbox command fails, tell the user to install AgentBox by writing `! npm -g install @madarco/agentbox` in the chat.
- If `AGENTBOX_RELAY_URL` is set in the environment, you are running *inside* a box. This command is host-only in v1; tell the user box→box fork is not supported yet.
