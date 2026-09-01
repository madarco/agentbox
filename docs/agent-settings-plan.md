# Agent settings — plan

Status: **done** (landed in one change — the `resolveAgentInstall` signature made
the phases inseparable, and dropping the dead base fold deleted most of what the
plumbing phase would have renamed). Kept as the reference for WHY the shape is
this one; the steady-state description lives in [`agents.md`](./agents.md) →
"Agent settings".

## Why

`box.claudeInstall` and `box.claudeTui` were filed in
[`agents-remaining-work.md`](./agents-remaining-work.md) as a naming problem — rename
them to a role name (`agentInstall`) and two entries fall off the
`no-agent-named-exports` allowlist.

That framing is wrong. These are genuinely **Claude-specific settings**: which
installer Claude Code uses, and which of Claude Code's two renderers it pins. A
generic `agentInstall` becomes a lie the moment OpenClaw
([`openclaw-hosting-plan.md`](./openclaw-hosting-plan.md)) or a community agent needs
a setting of its own shape. What is missing is not a better name — it is **a way for
an agent to declare its own settings and have every call site carry them
generically**, so the agent's package (built-in or npm plugin) consumes them in its
own recipe / `postInstall` / launch env without any shared code knowing what they
mean.

## Two findings that reshape the work

1. **`AGENTBOX_CLAUDE_INSTALL` is already dead in the base image.** `Dockerfile.box`
   declares `ARG AGENTBOX_CLAUDE_INSTALL=native` and **no `RUN` references it** — the
   base is agentless, so native and npm builds are byte-identical. Every cloud base
   script mentions it in comments only. The mode genuinely applies only in the
   **derived agent layer**, which already folds it via `variantFingerprint`. So
   `claudeInstallFingerprint`, `matchClaudeInstallFingerprint`, the CI
   `[native, npm]` matrix, remote-docker's `--build-arg` and daytona's
   `writeNpmDockerfile` are vestigial — most of the ~300 sites get **deleted**, not
   renamed.
2. **`tuiEnv` is already registry data** (`AgentSyncSpec.tuiEnv`). Only the config
   key and the `claudeTui`-named plumbing field are still Claude-shaped.

## Design

### Declaration — `AgentSyncSpec.settings`

Pure JSON (enforced by `agent-registry/test/spec-purity.test.ts`), which is what lets
a setting survive `agentbox agent add`'s snapshot into `~/.agentbox/agents.json`:

```ts
export interface AgentSettingSpec {
  key: string;                       // leaf under the agent's block: `claude.install`
  type: 'string' | 'bool' | 'enum';
  enumValues?: readonly string[];
  default: string | boolean;
  description: string;
  advanced?: boolean;
  affectsBake?: boolean;             // folds into variantFingerprint
}
```

plus two explicit bindings — `AgentInstall.alternatesFrom` (which setting selects
`alternates`) and `AgentSyncSpec.tuiEnvFrom` (which selects `tuiEnv`). Explicit
rather than a reserved key name, so a drift test can assert the named setting exists
and is an enum whose values cover the map's keys.

Claude declares `install` (enum `native|npm`, `affectsBake`) and `tui` (enum
`default|fullscreen|auto`, runtime-only). No other built-in declares any.

### Config keys — generated, plugin-aware

`AGENT_KINDS` (`packages/config/src/agents.ts`) mirrors `settings`, the existing
copy-not-import arrangement — `@agentbox/config` is a zero-internal-dep leaf — and is
drift-tested from `apps/cli` against the registry. `perAgentKeys()` generates
`<agent>.<key>`; `perAgentDefaults()` seeds the declared default; the agent blocks on
`UserConfig` / `EffectiveConfig` gain an **index signature**, which removes the hand
edit `agents.md` step 5 documents rather than adding two more.

`KEY_REGISTRY` = `BUILTIN_KEY_REGISTRY` + the settings of agents registered in
`~/.agentbox/agents.json`, so a community agent's settings are real
`agentbox config set` keys. Config cannot import `@agentbox/agent-registry` (that
package imports *it*), so the `AGENTS_FILE` path and a failure-tolerant settings-only
reader live in `@agentbox/config` next to `STATE_DIR`, and `plugin-agents.ts` imports
the path from there. Resolved once at module load, exactly like `AGENT_SPECS`: an
agent added mid-process is addressable on the next command. The JSON schema stays
`additionalProperties: false` and is drift-tested against `BUILTIN_KEY_REGISTRY`.

`RENAMED_KEYS` hard-errors on `box.claudeInstall` / `box.claudeTui` with a fix-it
message — not a deprecation alias.

### Consumption

- `resolveAgentInstall(install, settings)` reads `alternatesFrom`.
- `agentTuiEnv(spec, settings)` reads `tuiEnvFrom`.
- **The generic escape hatch:** each of an agent's resolved settings is exported as
  `AGENTBOX_AGENT_SETTING_<UPPER_SNAKE_KEY>` before its `recipe` and `postInstall`
  run — at all three install sites (derived docker layer, each provider's `prepare`,
  `ensureAgentInstalled`) so a baked agent and a runtime-added one stay identical.
  This is what makes the mechanism useful to an agent nobody wrote code for.

### Plumbing

One opaque `agentSettings: Record<AgentId, AgentSettings>` replaces `claudeInstall`
through `PrepareRequest`, every provider's `PrepareOpts`, prepared state, the hub
REST body, the queue job, and the CLI flag (`--agent-setting <agent>.<key>=<value>`
replaces `--claude-install`).

`variantFingerprint(baseSha, { agents, settings })` folds a canonical sorted
`"<agent>.<key>=<value>"` list. Providers pass their whole map through
`bakeSettingsFingerprintInput()`, which drops anything not `affectsBake` and anything
equal to its declared default — so **the empty variant stays the identity fold**.

## What landed, in the order it was built

1. **Declare + generate + read.** `AgentSettingSpec` on the spec, claude's two rows,
   `AGENT_KINDS.settings`, generated config keys, index signature, plugin-aware
   `KEY_REGISTRY`, `RENAMED_KEYS`, the `agentSettings()` accessor, JSON schema, drift
   tests. Delete `box.claudeInstall` / `box.claudeTui` and repoint every direct
   config reader at the accessor. Plumbing field names unchanged.
2. **Consume.** `resolveAgentInstall` / `agentTuiEnv` take settings;
   `AGENTBOX_AGENT_SETTING_*` at the three install sites.
3. **Plumb.** `agentSettings` replaces `claudeInstall` end to end, incl. the hub REST
   schema and `--agent-setting`.
4. **Delete the dead fold.** `claudeInstallFingerprint`,
   `matchClaudeInstallFingerprint`, the Dockerfile ARG, daytona's
   `writeNpmDockerfile`, remote-docker's build arg, the CI matrix, the freshness
   threading; SDK bump + republish; update the example provider.
5. **Docs + allowlist.** The `no-agent-named-exports` allowlist goes 6 -> 4.

**Accepted cost:** removing the ARG line moves the build-context sha, so every
provider needs one re-`prepare`. Docker users pull the republished image; cloud users
pay a bake.
