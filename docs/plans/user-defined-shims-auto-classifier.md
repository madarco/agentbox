# Plan: User-defined shims — a generic, relay-gated CLI bridge with an auto-classifier

## Context

AgentBox already proxies four host CLIs into boxes the safe way — `git`, `gh`,
`ntn` (Notion), `linear` — via the pattern: in-box **shim** → `agentbox-ctl` →
host **relay** classifies read/write → gates writes with `askPrompt` → shells
out to the host's authenticated CLI. Tokens never enter the box.

Today every one of these is **hand-built**: a bespoke bash shim, a TypeScript
connector descriptor, hardcoded op tables, and per-CLI guard functions. Adding a
fifth CLI is a code change + release. The user wants to invert this: a box user
runs `agentbox shims add <cli>` and the system **auto-generates** a profile so the
CLI is bridged into the next boxes — no AgentBox release, no first-party connector.

The proposed simple model is "a list of allowed commands + whitelisted args." The
core engineering question — and the reason this plan leads with analysis — is
**where that simple model breaks**, measured against the four shims we already
ship. The answer drives the architecture: a declarative ruleset for the easy
~80%, plus a **library of named predicate primitives** (lifted from the existing
guard functions) for the hard ~20%, plus a JS escape hatch. Auto-generation is a
**skill** that drives claude/codex to author the profile from the CLI's own
`--help`, because reliably parsing arbitrary CLI surfaces in code is itself one of
the failure modes.

Decisions locked with the user:
- **Deliverable**: design + an implementable v1 plan (this file).
- **Auto-gen**: scaffold + review, implemented as a **skill** so claude/codex
  builds the rules (not a brittle in-code `--help` parser).
- **Ruleset storage**: profiles dir (`~/.agentbox/shims/<name>.yaml`) + a predicate
  library; plus a `shims.<name>.enabled` config flag honoring the existing
  global/project/workspace/CLI override precedence.

---

## Part 1 — Where "command allowlist + arg whitelist" fails (the analysis)

Each row below is a **real guard in today's code** that a flat ruleset cannot
express, with the file it lives in and the predicate primitive (Part 2) that
rescues it. This catalog is the justification for the architecture.

### A. Read/write is not in the command name — it's in flag *interactions*
`gh api` / `ntn api` infer the HTTP method from a *combination* of args: an
explicit `-X/--method` (in space, glued `-XPOST`, or `=` forms) **OR** the mere
presence of a field flag `-f/-F/--field` which implicitly switches GET→POST.
- Proof: `refuseGhApiCall` (`packages/relay/src/gh.ts:135-192`), `refuseApiNonGet`
  (`packages/integrations/src/connectors/notion.ts:70-117`).
- Why a whitelist fails: it checks each arg independently; it cannot compute
  `method = explicitMethod ?? (anyFieldFlag ? POST : GET)` across the whole argv.
- Rescued by: **`httpApi` predicate**.

### B. The allowed value space is hierarchical, not enumerable
`gh api <endpoint>` is allowed only for specific **REST path templates** with
wildcards (`repos/:owner/:repo/pulls/:n/comments`), and GET is allowed on any
allowlisted path while POST is allowed only on the comment subset.
- Proof: `GH_API_ALLOWED_ENDPOINTS` / `isAllowedGhApiEndpoint` (regex over a
  normalized path, `gh.ts:66-95`).
- Why a whitelist fails: you can't enumerate every `:owner/:repo`; you need glob/
  template matching, *and* method↔path-subset correlation.
- Rescued by: **`httpApi` predicate** (endpoint globs + per-method subsets).

### C. An allowed-looking READ leaks a secret (output sensitivity)
`linear auth token` prints the raw API key to stdout. It has no write side-effect,
so a naive read/write classifier labels it a safe read — exactly wrong. Same
shape: `gh api /user/keys`, or exfil *channels* embedded in otherwise-fine args:
`--input @file` (stdin/file body), `--variable key=@/etc/passwd` (host-file load).
- Proof: linear-shim hard-rejects `auth token` (`packages/sandbox-docker/scripts/linear-shim`);
  `refuseGraphqlNonQuery` refuses `@<path>` and `--input`
  (`connectors/linear.ts:123-212`); `refuseGhApiCall` refuses `--input` (`gh.ts:161-164`).
- Why a whitelist fails: it has no concept of "this command's *output* is the
  credential" or "this arg *value* opens a file-read channel."
- Rescued by: **`denySecretOutput`** + **`refuseFileLoadArgs`** predicates.

### D. The gate depends on live HOST state at call time
`gh pr checkout` is refused if the host working tree is dirty, or if the host
HEAD is currently on a registered box branch (`agentbox/*`) — it would corrupt the
bind-mounted box. `git push` is *ungated* for `agentbox/*` branches but *prompts*
for any other branch — a decision made from the box's resolved worktree at
runtime.
- Proof: `checkoutGuards` (`gh.ts:397-441`, probes `git status --porcelain` + HEAD
  vs the registered-branch set); branch-prefix gate (`server.ts:~420`,
  `isAgentboxBranch`).
- Why a whitelist fails: the verdict is a function of host filesystem/git state
  and the live set of box branches, not of the argv.
- Rescued by: **`hostStateGuard` predicate**.

### E. The argv must be REWRITTEN, not just allowed/denied
`gh pr create` has `--head <box-branch>` *injected* so the PR targets the box's
work (recognizing 3 spellings to avoid double-inject), and refuses outright if no
head can be resolved. `gh repo clone` argv is *reordered* (positionals first) for
the commander parser.
- Proof: `injectPrCreateHead` / `prCreateNeedsHead` (`gh.ts:194-242`); clone
  reorder (`gh-shim:254-289`).
- Why a whitelist fails: allow/deny/prompt has no "transform/inject" verb; the
  correct call literally differs from what the box typed.
- Rescued by: **`argvInject` / `argvReorder` transforms** in a rule.

### F. Some writes need a higher tier than "prompt"
With `AGENTBOX_PROMPT=off` (auto-approve), `gh pr merge` *still* refuses unless
`AGENTBOX_GH_FORCE=1` — irreversibility warrants an extra interlock. `gh pr
checkout` is disabled entirely unless an opt-in env is set.
- Proof: `refuseMergeBypass` (`gh.ts:463-479`), `refuseCheckoutByDefault`
  (`gh.ts:481-495`).
- Why a whitelist fails: gating is not binary (read|write); there's a third
  "never silently auto-approve / opt-in only" tier.
- Rescued by: per-rule **`tier: irreversible | opt-in`** flag.

### G. Interactive / streaming / no-TTY commands break the request/response model
`gh run watch` is deliberately excluded (blocks until CI finishes). `gh run view`
with no run-id would spawn an interactive picker that hangs with no TTY, so the
shim *requires* a positional. Any wrapped CLI that paginates, prompts, or streams
will hang the relay round-trip.
- Proof: `GH_RUN_OPS` omits `watch` (`gh.ts:48-64`); `gh-shim:196-202` requires a
  run-id.
- Why a whitelist fails: it has no notion of "this subcommand is interactive/
  unbounded." The auto-generator can't infer this from `--help` either.
- Rescued by: per-rule **`requirePositional`** + a `deny`/`needsManualReview`
  marker the skill sets; documented as a residual limit.

### H. The CLI surface itself is unreliable to discover in code
Read/write semantics can't be inferred from a subcommand name alone, help formats
differ per CLI, and names drift (`linear issue comment add`, not `create` — the
exact mistake made in the Linear brief and caught only at runtime).
- Why an in-code auto-parser fails: brittle, and unsafe when wrong.
- Rescued by: **auto-gen is a skill**, not code — claude/codex reads `--help`,
  reasons about read/write + danger, and writes the profile for human review.

### I. Auth mechanism is heterogeneous (provisioning)
`ntn` needs `NOTION_KEYRING=0`; `linear` reads a plaintext TOML; `gh` uses its own
store; Trello uses `TRELLO_API_KEY/_TOKEN`. A connector may only inject env in its
own `<NAME>_*` namespace.
- Proof: `mergeConnectorEnv` (`packages/relay/src/integrations.ts:176-189`) throws
  on out-of-namespace keys; `env: { NOTION_KEYRING: '0' }` (notion connector).
- Why a whitelist fails: it has no env model. The generator can't know the auth
  mechanism — it must be a reviewable field, namespace-enforced.
- Rescued by: profile `env` (namespace-checked by the existing `mergeConnectorEnv`)
  + `detect.authArgs`.

### J. A user-generated shim can't be baked into the image
All four current shims are COPY'd into `Dockerfile.box` and listed across five
provider arrays in `stage-runtime.mjs` (`gh-shim`, `git-shim`, `ntn-shim`,
`linear-shim`). A user adding a shim post-build cannot rebuild the image.
- Why the current provisioning fails: it's build-time + static.
- Rescued by: **one generic dispatcher baked once**, plus **create-time injection**
  of a tiny per-CLI forwarder (just the binary name); the *ruleset stays host-side*
  and never enters the box.

**Conclusion.** The flat model cleanly handles a CLI whose read/write split is
per-subcommand with enumerable args and no embedded API/secret semantics
(Trello-like). It cannot handle raw API/GraphQL passthroughs (A/B), output-secret
reads (C), host-state-contextual gates (D), argv rewriting (E), irreversibility
tiers (F), or interactive commands (G) — and those are precisely the load-bearing
parts of `git`/`gh`/`ntn`/`linear`. So the system = **declarative core for the
common case + a predicate library for the hard cases + an LLM skill to author
both**, with the relay (not the box) holding all intelligence.

---

## Part 2 — Architecture

### Central move: dumb box-side forwarder, smart host-side relay
Unlike today's per-CLI bash shims (which embed dispatch logic), the box side
becomes a **single generic forwarder**. ALL classification lives host-side in a
profile the relay loads — richer than bash, editable without an image rebuild,
and never exposed to the box.

```
box: `linear issue create …`
  └─ /usr/local/bin/linear  (create-time wrapper)  ->  exec agentbox-ctl shim linear -- "$@"
       └─ ctl POST /rpc  method="shim.linear", params={ argv:[…], path:cwd, hostInitiated? }
            └─ relay: load profile linear.yaml -> ROUTE argv to a rule ->
                 enable-gate (shims.linear.enabled) ->
                 rule.access: read|write|deny + predicate guard + argv transform ->
                 write? askPrompt (reuse) / host-initiated token (reuse) ->
                 spawn host `linear <built argv>` with namespaced env ->
                 {exitCode,stdout,stderr} back to box
```

This reuses, unchanged: `askPrompt`/`PromptSubscribers` (`prompts.ts`),
`HostInitiatedTokens`/`hashRpcParams` (`host-initiated.ts`), `mergeConnectorEnv`
and the `runHostBinary` spawn (`relay/src/integrations.ts`), `postRpcAndExit`
(`ctl/relay-rpc.ts`), and the `HostActionQueue`/`CloudBoxPoller` cloud round-trip
(method-prefix-agnostic).

### Profile schema (`~/.agentbox/shims/<name>.yaml`) — the easy 80%
```yaml
name: linear            # wire name + default bin
bin: linear             # host binary the relay execs (PATH-resolved)
detect:
  versionArgs: [--version]
  authArgs: [auth, whoami]
  installHint: "npm i -g @schpet/linear-cli"
  loginHint: "linear auth login"
env: {}                 # only LINEAR_* keys allowed (mergeConnectorEnv enforces)
rules:                  # ordered; first match wins
  - match: [auth, whoami]            # subcommand path prefix
    access: read
  - match: [issue, list]
    access: read
  - match: [issue, create]
    access: write                    # -> askPrompt
  - match: [issue, comment, add]
    access: write
  - match: [auth, token]
    access: deny
    reason: "prints the raw API key"
    guard: denySecretOutput
  - match: [api]
    access: read
    guard: { graphql: { queriesOnly: true } }   # predicate (Part C/A/B)
  - default: prompt                  # safe default for unmatched argv
# Optional per-rule arg constraints:
#   allowFlags: [--json, --state]
#   denyFlags:  [--input]
#   denyArgValues: ['@']             # refuse @<path>-shaped values anywhere
#   requirePositional: true          # avoid no-TTY interactive picker (Cat G)
#   tier: irreversible               # never silent-auto-approve (Cat F)
#   transform: { argvInject: { flag: --head, value: "$boxBranch", when: [pr, create] } }
```

### Predicate library (the hard 20%) — `packages/integrations/src/predicates.ts`
Each is a parameterized factory returning the existing `(args) => Refusal | null`
shape (so it slots into the current `refuseCall` path). Implementations are
**lifted from today's hand-written guards** so behavior is identical and tested:
- `httpApi({ methods, endpoints, writeEndpoints })` — generalizes
  `refuseGhApiCall` + `refuseApiNonGet`: argv method inference (`-X/--method`,
  field-flag→POST), endpoint glob/template match, method↔subset correlation,
  `--input` refusal. (Cat A, B)
- `graphql({ queriesOnly })` — generalizes `refuseGraphqlNonQuery`: parse the
  GraphQL positional, refuse `mutation`/`subscription`, refuse `--variable @<path>`
  / `--input`, comment/whitespace/BOM tolerant. (Cat A, C)
- `denySecretOutput({ reason })` — unconditional refusal for secret-printing ops
  like `auth token`. (Cat C)
- `refuseFileLoadArgs()` — refuse `@<path>` / `--input` value shapes anywhere. (Cat C)
- `hostStateGuard({ requireCleanTree, refuseOnBoxBranch })` — generalizes
  `checkoutGuards`: probe host `git status`/HEAD vs the registered-branch set. (Cat D)
- argv transforms `argvInject` / `argvReorder` — generalize `injectPrCreateHead` /
  clone reorder; resolvers like `$boxBranch` filled from the registered worktree. (Cat E)
- escape hatch `guard: ./guard.mjs#fn` — load a user JS module exporting the
  `refuseCall` signature, for anything bespoke.
`tier: irreversible|opt-in` on a rule generalizes `refuseMergeBypass` /
`refuseCheckoutByDefault` (Cat F) — enforced in the dispatch, not a predicate.

### Registry integration
A profile **compiles to the existing `IntegrationConnector` shape**
(`bin`→`hostBin`, `rules`→`ops` + a routing table, `env`, `detect`) so it flows
through the relay's existing dispatch. Extend the static `ALL_CONNECTORS`
(`packages/integrations/src/registry.ts`) with a dynamic loader that reads
`~/.agentbox/shims/*.yaml`. The one genuinely new piece: today the *shim* resolves
subcommand→op; here the **relay routes raw argv→rule** from the profile's ordered
`rules` (a small matcher in `relay/src/shims.ts`).

### Provisioning (resolves Cat J)
- Bake **one** generic dispatcher `packages/sandbox-docker/scripts/agentbox-shim`
  (infers wire-name from `argv[0]`, `exec agentbox-ctl shim "$name" -- "$@"`).
  Register it once in `stage-runtime.mjs` (the `execBitFiles`/`contextFiles` +
  `hetznerFiles`/`vercelFiles`/`e2bFiles` arrays) + `Dockerfile.box` COPY +
  `install-box.sh` mirror — same five-place dance as existing shims, but only once.
- At **box-create time**, the CLI reads the enabled-shim list (`shims.*.enabled`
  effective config) and, for each, drops `/usr/local/bin/<bin>` as a 1-line
  `exec agentbox-shim` symlink/wrapper via the provider's existing file-injection
  path (docker cp/exec, hetzner scp, vercel/e2b upload). **Profiles never enter
  the box** — only the bin name + the generic forwarder.

---

## Part 3 — Auto-generation as a skill (`agentbox shims add <cli>`)

`agentbox shims add linear [--bin linear]`:
1. Scaffolds `~/.agentbox/shims/linear.yaml` with `name/bin/detect` stubbed and an
   empty `rules` + `default: deny`.
2. Launches the **`shim-author` skill** (new, shipped under
   `apps/cli/share/shim-author/SKILL.md`; invokable by claude/codex). The skill
   instructs the agent to, **host-side**:
   - run `<cli> --help` and each subcommand `--help`, enumerate the surface;
   - classify each subcommand read/write by semantics (get/list/view/show→read;
     create/update/delete/add/move→write), defaulting uncertain ones to `prompt`;
   - **flag and `deny` (with a TODO) every dangerous surface it must not auto-enable**:
     any `api`/`graphql` passthrough (wire a `httpApi`/`graphql` predicate with
     endpoints left for the human), any `token`/secret-printing op
     (`denySecretOutput`), any `delete`/destructive op, anything interactive/
     streaming (Cat G);
   - write the profile YAML and summarize what it could/couldn't safely classify.
3. The user reviews/edits, runs `agentbox shims test linear -- <argv>` (host-side
   dry-run: prints the matched rule + read/write/deny verdict, **no execution**) to
   validate, then `agentbox shims enable linear`.

`agentbox shims` subcommands: `add | list | show | edit | test | enable | disable
| remove`. `agentbox doctor` reports each loaded profile (extend the existing
`ALL_CONNECTORS` iteration in `apps/cli/src/lib/doctor-checks.ts` to include
profiles).

**Residual limits to document honestly** (the skill marks these `deny`+TODO, never
auto-enables): exact `httpApi` endpoint globs need human confirmation (B);
output-secrecy must be guessed (C); interactivity can't be inferred from help (G).

---

## Part 4 — Config

Add a `shims` block mirroring `integrations`, in `packages/config/src/types.ts`:
```ts
// UserConfig:   shims?: Record<string, { enabled?: boolean }>;
// EffectiveConfig: shims: Record<string, { enabled: boolean }>;   // default {}
```
- Precedence is the existing global<project<workspace<CLI merge (reuse
  `loadEffectiveConfig`); `agentbox shims enable/disable` writes
  `shims.<name>.enabled` at the chosen layer.
- The relay enable-gate generalizes `refuseIfIntegrationDisabled`
  (`relay/src/integrations.ts:291-315`) to a `refuseIfShimDisabled(name, cwd)`
  reading `shims.<name>.enabled`.
- **New wrinkle**: `KEY_REGISTRY` is a static list (`config/src/types.ts:~875`);
  it can't enumerate dynamic shim names. Add wildcard handling so
  `shims.<anything>.enabled` validates as a `bool` key (a `KEY_PATTERNS` entry
  alongside the static registry). This is the one config-system change.

---

## Critical files

- **New** `packages/integrations/src/profile.ts` (schema + `compileProfile`),
  `packages/integrations/src/predicates.ts` (predicate library — lift from
  `gh.ts`/`notion.ts`/`linear.ts` guards), `packages/integrations/src/profile-loader.ts`
  (read `~/.agentbox/shims/*.yaml`).
- **New** `packages/relay/src/shims.ts` — argv→rule router, `shim.<name>` dispatch,
  enable-gate, tier enforcement. Wire the `shim.` prefix into
  `packages/relay/src/server.ts` (POST /rpc) **and** `packages/relay/src/host-actions.ts`
  (cloud), beside the `integration.` branch.
- **New** `packages/ctl/src/commands/shim.ts` — `agentbox-ctl shim <name> -- <args>`.
- **New** `apps/cli/src/commands/shims.ts` — the `agentbox shims …` surface;
  register in `apps/cli/src/index.ts`.
- **New** `packages/sandbox-docker/scripts/agentbox-shim` (generic dispatcher) +
  create-time per-bin injection in each provider's create path.
- **New** `apps/cli/share/shim-author/SKILL.md` (the auto-gen skill).
- **Edit** `apps/cli/scripts/stage-runtime.mjs` (+`Dockerfile.box`,
  `install-box.sh`) — register `agentbox-shim` once; **edit** `packages/config/src/types.ts`
  (`shims` block + wildcard KEY validation); **edit** `apps/cli/src/lib/doctor-checks.ts`.
- **Reference (copy/lift from)** `packages/relay/src/gh.ts`, `connectors/notion.ts`,
  `connectors/linear.ts`, `relay/src/integrations.ts`, `host-initiated.ts`,
  `prompts.ts`, `sandbox-docker/scripts/{gh,git,ntn,linear}-shim`.
- **Docs (same change)** new `docs/shims.md`; public `.mdx` + `meta.json` under
  `apps/web/content/docs/`; mention in `docs/host-relay.md` (new `shim.*` method) +
  `docs/features.md`.

## Implementation phases (each its own box/PR, mirroring the integrations cadence)
1. **Predicate library + profile schema/compile** (pure `@agentbox/integrations`,
   unit-tested by porting the existing `refuse*` tests). No box wiring yet.
2. **Relay `shim.*` dispatch + profile loader + enable-gate**, wired into
   `server.ts` + `host-actions.ts`; ctl `shim` command. Unit tests for argv→rule
   routing + write-gate + tier.
3. **Provisioning**: generic `agentbox-shim` baked once + create-time per-bin
   injection across providers; `shims` config block + wildcard key validation.
4. **`agentbox shims` CLI** (`add/list/show/test/enable/disable/remove`) + the
   `shim-author` skill + `doctor` integration + docs.
5. **Live e2e**: `agentbox shims add` a real CLI, skill authors the profile,
   review, enable, box read (no prompt) + write (prompt) + denied `auth token`,
   no-token assertion. Then optionally re-express one built-in (e.g. `linear`) as a
   profile to prove parity and retire its bespoke connector.

## Verification
- **Unit**: predicate parity tests (the ported `refuseGhApiCall` / `refuseApiNonGet`
  / `refuseGraphqlNonQuery` / `checkoutGuards` cases must pass against the lifted
  predicates); profile compile + argv→rule routing; `shims test` dry-run golden
  output; enable-gate refuses when `shims.<name>.enabled` false.
- **e2e** (docker first, then one cloud per "fix across all providers"): the Part-5
  flow, asserting reads skip the prompt, writes gate via `askPrompt`, `deny`/secret
  ops refuse, argv-inject/host-state guards fire, and `printenv` in the box shows
  only `AGENTBOX_RELAY_TOKEN`. Ground-truth every write (don't trust exit codes).

## Out of scope / follow-ups
- Migrating the four built-in connectors onto profiles (parity proof in phase 5 is
  optional; full migration is a later cleanup — no deprecation churn now).
- Per-rule rate limits / audit log of proxied calls.
- A shared community profile registry (`agentbox shims add <cli> --from <url>`) —
  note the trust implications; out of scope for v1.
</content>
