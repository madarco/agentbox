# agentbox-agent-example

A complete AgentBox **agent plugin**, in one dependency-free file — the reference
for `agentbox agent add`, and the agent counterpart to
[`agentbox-provider-example`](../agentbox-provider-example).

## Try it

```console
$ agentbox agent add ./examples/agentbox-agent-example
registered example-agent from agentbox-agent-example@0.1.0

$ agentbox agent list
claude               built-in
codex                built-in
opencode             built-in
example-agent        agentbox-agent-example@0.1.0 (agent API v1)

$ agentbox agent remove agentbox-agent-example
```

## What a package has to export

**`agentSpec`** — the data. Where the agent's config lives on the host and in a
box, how it installs, what it can do. Every field is a string, array or plain
object, because the spec is shipped into boxes whose baked `agentbox-ctl` may
predate the agent entirely (it arrives over the `agents.list` RPC). That same
property is what lets `agent add` snapshot it into `~/.agentbox/agents.json`,
where every reader resolves it **synchronously and offline** — nothing has to
import your package to know your agent exists.

**`agentSyncModule`** — optional. Only needed to create a **docker** box, which
requires knowing how to mount the agent's config volume. Everything declarative
— listing, resolving by id or alias, and staging your host config into every
cloud provider's baked snapshot — works from `agentSpec` alone. A data-only
package is valid, not a failure.

**`AGENT_API_VERSION`** (or `agentbox.agentApiVersion` in `package.json`) — the
compat gate. A package targeting a version this build does not support is
skipped, never fatal.

## Why this file imports nothing

An agent package never enters AgentBox's build graph. Its data is a snapshot in
a file; its code is reached through a *variable* `import()` of the entry path
recorded at add time. That is what makes a plugin agent structurally exempt from
the package cycle that forces AgentBox's own agents to keep data
(`packages/agent-registry`) and behaviour (`packages/agent-<id>`) in separate
packages — see [`docs/agents.md`](../../docs/agents.md).

## What you cannot do

Claim a built-in agent's id **or one of its aliases**. `agent add` refuses it, so
nothing can quietly take over `agentbox claude`.
