---
description: Fork the current Codex session into a new AgentBox box and resume it there (opens in a new terminal tab).
argument-hint: [provider]
---
<!-- agentbox-managed:v1 -->

Fork the current Codex session into a fresh AgentBox box running Codex.

Optional provider argument: `$ARGUMENTS` (docker | daytona | hetzner | vercel | e2b | digitalocean | aws; default docker).

## Steps

1. **Pre-flight (stop on either):**
   - If `AGENTBOX_RELAY_URL` is set in the environment, you are running *inside* a box — box→box fork is not supported yet; stop and tell the user.
   - If `which agentbox` fails, tell the user to install AgentBox (`npm -g install @madarco/agentbox`) and stop.

2. **Find the current Codex session id.** Codex exposes it as `CODEX_THREAD_ID` in your shell. Run via your shell tool:

   ```
   printenv CODEX_THREAD_ID
   ```

   That prints the session `<uuid>`. If it prints nothing (older Codex without the variable), fall back to the most recently written rollout file (that is the live session):

   ```
   ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -1 \
     | xargs -I{} basename {} .jsonl \
     | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   ```

   If both print nothing, stop and tell the user no Codex session was found for this machine.

3. **Resolve the provider flag from `$ARGUMENTS`:** empty → none; `docker` | `daytona` | `hetzner` | `vercel` | `e2b` | `digitalocean` | `aws` → `--provider $ARGUMENTS`; anything else → stop and report the valid values.

4. **Fork.** Run, via your shell tool:

   ```
   agentbox fork --agent codex --session <uuid> [--provider <from step 3>]
   ```

   (`agentbox fork` autodetects Codex from `CODEX_THREAD_ID` on its own, so a bare `agentbox fork` works too — passing `--agent codex --session <uuid>` explicitly is just the most reliable form.)

5. **Report** the new box name from the command output. Your current Codex session is unaffected — you now have two parallel timelines.
