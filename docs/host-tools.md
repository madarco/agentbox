# Host tools — the box→host CLI proxy

> Part of the AgentBox docs. Start at [CLAUDE.md](../CLAUDE.md). The user-facing page is `apps/web/content/docs/host-tools.mdx` (published at https://agent-box.sh/docs/host-tools).

An in-box agent often needs a CLI whose credentials must never enter the box —
`gh`, `terraform`, `aws`, `kubectl`, `ntn`, `linear`. Host tools are the one
mechanism for all of them: the box gets a shim, the **host** runs the real
binary with its own auth, and only the result crosses back.

## Why this shape

The predecessor was a per-service "connector": a hand-written bash shim with a
subcommand allowlist, a descriptor with per-op read/write classification, a
typed config key, and an image rebake — per CLI. That is why only Notion and
Linear ever shipped. Neither needed special auth handling (the relay spawned
them with plain `process.env` and each CLI read its own auth store), so neither
was ever really a special case. They were deleted; both still work, as ordinary
host tools.

What replaced them:

- **One shim, not one per tool.** `packages/sandbox-docker/scripts/agentbox-tool-shim`
  is a three-line multi-call script baked once per image. It reads its own name
  from `argv[0]` and forwards to `agentbox-ctl tool run <name> -- "$@"`. Adding
  a tool is a symlink, not a rebake.
- **The gate is one place.** `packages/relay/src/host-tools.ts` on the host.
  The shim does no argv filtering, deliberately — it was never the security
  boundary (see [`architecture.md`](./architecture.md)), and a second opinion in
  the box would only be a confusing one.

## The trust model

```
agentbox.yaml  tools: [terraform]          <- the project REQUESTS (committed, untrusted)
        |
        v  one carry-style prompt at create time
~/.agentbox/projects/<hash>/tools.yaml     <- the host GRANTS (host-only, authoritative)
        |
        v  re-read on every call, fails closed
host binary, spawned in the worktree's host repo
```

An `agentbox.yaml` is committed, so a repo you cloned must not be able to hand
its own box your AWS credentials by declaring `tools: [aws]`. It can only ask.
The relay consults the **grant** file alone, so an unapproved request is inert.

Grants live in their own `tools.yaml` rather than `config.yaml` because
`KEY_REGISTRY` is a closed registry of typed scalar keys, while a grant list is
an open map written by an approval flow. Layered global < project, the same way
config is; a project grant wins on name collision so a project can narrow what a
global grant allows.

## Granting

```bash
agentbox tools add terraform                      # this project
agentbox tools add aws --global                   # every project
agentbox tools add aws --allow '^s3 ls' --deny '^s3 rm'
agentbox tools add terraform --timeout 600000     # long plans
agentbox tools list
agentbox tools rm terraform
```

`gh` is granted built-in — Claude Code's PR badge and our documented agent flows
call it — and keeps its own relay handler (`packages/relay/src/gh.ts`: PR-branch
injection, the `gh api` endpoint allowlist, the safe auto-approve op set).
Routing it through the generic proxy would silently drop those guards, so
`tool.run` refuses it by name. Revoke with
`agentbox config set tools.gh.enabled false`.

## The `tools:` block

```yaml
tools:
  - terraform # bare list: default gating
  - ntn

  # or the mapping form, for options
  aws:
    bin: aws
    allow: ['^s3 ls', '^sts ']
    deny: ['^s3 rm', '^iam ']
    timeoutMs: 300000
```

Both spellings are accepted. `allow`/`deny` are JS regexes matched against the
space-joined argv; they are compile-checked at parse time, because a `deny`
pattern that silently never matches would be a hole rather than a typo.

## The gate, in order

`tool.run` in `packages/relay/src/server.ts` (docker) and
`packages/relay/src/host-actions.ts` (cloud) run the identical sequence, per the
"fix across all providers" rule:

1. **worktree resolve** — `params.path` picks the registered worktree. Exit 64.
2. **grant lookup** — re-read every call, so an approval takes effect without
   bouncing the relay. Ungranted → exit 65 with both remedies in the message.
3. **built-in credential deny list** — before any prompt, before any spawn.
4. **per-tool `deny`** — layered on top of (3), never replacing it. An invalid
   pattern is exit 78, not a silent pass.
5. **gate** — silent when the argv matches an `allow` pattern, or when the box
   runs with `box.autoApproveSafeHostActions` (the default). Otherwise
   `askPrompt` with the full argv; denial is exit 10. Either way the call is
   audited to the relay event ring buffer.
6. **spawn** — `runHostBinary` in the worktree's `hostMainRepo`, with the host's
   own env and credentials.

### The built-in credential deny list

`CREDENTIAL_ARGV_PATTERNS` refuses argv that makes a CLI print a credential to
stdout, which the box would capture: `auth token`, `auth print-access-token`,
`configure get`, `get-token`, `secrets get`, `--show-secret`, and friends. It is
deliberately broad — a false positive costs one `--allow` pattern, a false
negative leaks a host credential into an untrusted box.

This is the generic replacement for the old Linear connector's bespoke
`linear auth token` hard-reject, and it now covers `gh auth token` and
`aws configure get` too, which the connector model never did.

## Discovery and requests from inside a box

```bash
agentbox-ctl tool list                                  # granted tools only
agentbox-ctl tool request terraform --reason "plan the infra"
```

`tool list` never enumerates the host's PATH — a box should not be able to
inventory the machine it runs on.

`tool request` probes the host **before** prompting, so a box that guesses wrong
(`tool request terrafrom`) gets a direct exit-127 "not installed on the host"
instead of interrupting the user with an approval for a binary that could never
run. That does let a box learn whether one specific binary exists, which is why
requests are gated by `tools.request.enabled` (default true) and every one is
recorded as a relay event.

On approval the grant is written and the command becomes usable **without
restarting the box** — see below.

## How a tool reaches the box

The shim is baked once. The *set* of tools is a set of symlinks that the in-box
`agentbox-ctl` daemon keeps in step with the host's grant list, polling
`tool.list` (`packages/ctl/src/tool-links-watcher.ts`) every ~15s. Approving a
request makes the command appear; revoking a grant makes it disappear.

The links land in `~/.local/bin`, not `/usr/local/bin`, for a concrete reason:
the ctl daemon runs as `vscode`, not root. `~/.local/bin` is vscode-owned and is
already first on PATH on every provider — the Dockerfile's `ENV PATH` and each
cloud provider's `/etc/profile.d/agentbox.sh` both prepend it.

A real binary already owning the name is reported as a **conflict** and left
alone. Clobbering it would lose the user's install; silently shadowing it with a
host proxy would be a nasty surprise.

## Limits

`runHostBinary` runs with stdin ignored, no TTY, and buffered output. Host tools
are for **short, non-interactive** commands. `timeoutMs` (default 120s) covers
`terraform plan`-shaped waits; anything genuinely interactive is out of scope.

## Doctor

`agentbox doctor` grows a `tools` group, one row per grant, probing the host
binary with no forced env — exactly as the relay does, so what doctor reports is
the state the relay would actually hit.

## Notion and Linear

Both work as generic host tools. Neither needs a descriptor:

```bash
agentbox tools add ntn                       # https://developers.notion.com/reference/notion-cli
agentbox tools add linear                    # @schpet/linear-cli
```

`linear auth token` and `ntn`'s equivalents are refused by the built-in
credential deny list, so the old connector's key security invariant survives the
deletion. Narrow further per project with `deny:` in `agentbox.yaml`.

## Open follow-ups

- **Box→hub→host channel.** The remote-hub path (a box talking to a control box
  rather than a local relay) is not exercised yet; grants resolve against the
  host filesystem, which a hosted control plane does not share. Tracked
  separately.
- **Streaming output.** Buffered-only today; a long-running tool gives nothing
  until it exits.
