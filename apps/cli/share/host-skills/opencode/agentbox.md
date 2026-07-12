---
description: Spawn a parallel AgentBox box running OpenCode for this project (opens in a new terminal tab). Note - the current OpenCode session is not resumed yet; this starts a fresh session.
---
<!-- agentbox-managed:v1 -->

Spawn a new AgentBox box running OpenCode for the current project, in a new terminal tab.

Optional provider argument: `$ARGUMENTS` (docker | daytona | hetzner | vercel | e2b | digitalocean | aws; default docker).

**Note:** resuming an OpenCode session into a box isn't supported yet (sessions live in a shared SQLite DB), so this starts a **fresh** OpenCode session in the box — it does not carry the current conversation.

## Steps

1. **Pre-flight (stop on either):**
   - If `AGENTBOX_RELAY_URL` is set in the environment, you are running *inside* a box — not supported; stop and tell the user.
   - If `which agentbox` fails, tell the user to install AgentBox (`npm -g install @madarco/agentbox`) and stop.

2. **Resolve the provider flag from `$ARGUMENTS`:** empty → none; `docker` | `daytona` | `hetzner` | `vercel` | `e2b` | `digitalocean` | `aws` → `--provider $ARGUMENTS`; anything else → stop and report the valid values.

3. **Fork.** Run, via your shell tool:

   ```
   agentbox fork --agent opencode [--provider <from step 2>]
   ```

4. **Report** the new box name from the command output.
