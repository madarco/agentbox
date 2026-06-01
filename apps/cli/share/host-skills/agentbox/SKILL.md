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

2. **Detect an active plan (optional `--plan`).** If this session was just working on a Claude Code plan, carry it into the box so the fork resumes in plan mode.
   - **If you know the plan file path** for this session (plan mode writes it to `~/.claude/plans/<slug>.md`, and you have it from the plan you just produced in this conversation), use that path.
   - **Otherwise**, find the most recent plan only if it was touched in the last 15 minutes (a stale plan from another task should not be resurrected). Run via the Bash tool:

     ```
     find "$HOME/.claude/plans" -name '*.md' -mmin -15 -type f 2>/dev/null \
       | xargs -r ls -t 2>/dev/null | head -1
     ```

     If it prints a path, that's the current plan; if it prints nothing, there is no active plan — skip `--plan`.

3. **Fork.** Run, via the Bash tool, exactly one command (add `--plan "<path>"` only if step 2 found a plan):

   ```
   agentbox fork --session ${CLAUDE_SESSION_ID} [--provider $ARGUMENTS] [--plan "<plan path>"]
   ```

4. **Report.** In one line, give the user the new box name (parse it from the command output) and confirm their host session is unaffected. If you passed `--plan`, mention the box opens in plan mode ready to resume. Do not summarize the conversation — the fork already carries it.

## Troubleshooting

- If agentbox command fails, tell the user to install AgentBox by writing `! npm -g install @madarco/agentbox` in the chat.
- If `AGENTBOX_RELAY_URL` is set in the environment, you are running *inside* a box. This command is host-only in v1; tell the user box→box fork is not supported yet.
