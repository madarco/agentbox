# Persistent boxes & service agents — backlog

Minor / deferred items found while implementing `service-boxes-plan.md`. Each phase appends
here rather than sidequesting. Promote an item to the plan if it turns out to be load-bearing.

## From Phase 0 (openclaw PoC, 2026-09-02)

- **`--allow-scripts=openclaw` leaves four dependency install scripts unrun** — `koffi` (native
  FFI), `tree-sitter-bash` (node-gyp-build), `protobufjs`, `@google/genai`. openclaw installs and
  serves anyway, but a feature routed through those deps may be silently degraded. Decide whether
  to broaden the allowlist once a real channel is exercised.
- **openclaw is 893 MB installed.** If we ever want a baked variant, measure the pull cost first;
  on-demand install is the default for good reason.
- **Channel pairing is unverified.** `openclaw channels add --use-env` and *which* dirs a pairing
  needs to survive a restart both need a real credential. Do it when a channel is first wired.
- **`~/.config/openclaw` is empty after onboard.** It is persisted on the assumption it holds the
  auth-profile encryption key; confirm when auth profiles are actually used.

## From Phase 7 (deferred, needs real money / shared state)

- Re-run the base bake for the VPS providers after the openclaw row lands:
  `agentbox prepare --provider hetzner` and `agentbox prepare --provider digitalocean`.
  Watch for the `box.image` cross-provider collision (`agentbox config unset box.image --project`
  to recover).

## From Phases 2-3 (service-agent surface + layered config, 2026-09-02)

- **`agentbox <agent> stop` bypasses the hub.** The hub's services routes expose `restart` but not
  `stop`, so `service-factory.ts` reaches the box's ctl through `provider.exec`. Every other box
  operation goes behind `/api/v1`; add a stop route and drop the direct exec.
- **The `AGENT` column shows `unknown` for a service agent.** Phase 2 called for `agentbox list`
  and the hub payload to read the ctl SERVICE state for a `surface: 'service'` agent instead of
  probing a tmux session that will never exist. Left out here because it lands in
  `apps/cli/src/commands/list.ts` and the hub box payload, both outside this change's blast radius.
  Do it with (or before) Phase 6, when there is a real service agent to see it on.
- **The JSON schema squiggles an agent's overlay key.** `agentbox.schema.json` stays
  `additionalProperties: false` on purpose — it drives editor autocomplete, where flagging
  `defualts:` as you type is worth more than a clean overlay block — so a service agent's
  `overlayKey` shows as an unknown top-level key in an editor while the supervisor accepts it. If
  that becomes annoying, the fix is a generated per-project schema, not a wildcard.
- **`agent render` re-asserts the whole overlay when the record is lost.** Dropping
  `~/.<agent>/.agentbox-overlay.json` (a checkpoint that misses it, a wiped config volume) makes the
  next render send every key, overwriting in-box hand edits to keys the overlay names. That is the
  safe direction, but it is worth surfacing in the output rather than doing quietly.
- **The overlay is resolved once, at render time.** A `{{AGENTBOX_*}}` placeholder is baked into the
  overlay record, so a box renamed after a render sees the old value until the overlay itself
  changes. Fine today (the placeholders are box identity, set at create); revisit if a placeholder
  ever becomes mutable.
