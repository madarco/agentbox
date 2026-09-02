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

- Re-run the base bake for the VPS providers now that the openclaw row has landed. Not run from
  inside a box: it costs real money and mutates shared prepared state.

  ```sh
  node apps/cli/dist/index.js prepare --provider hetzner
  node apps/cli/dist/index.js prepare --provider digitalocean
  ```

  Watch for the `box.image` cross-provider collision (`agentbox config unset box.image --project`
  to recover). Note the bake is **not required for openclaw**: nothing openclaw needs was added to
  either provider's `install-box.sh` or runtime-asset list — the binary comes from the catalog on
  demand and the units ride `agents.list`. The re-bake is only to pick up whatever else has moved
  in the base since the last one.
- **Live-verify openclaw on the VPS providers** once the above has run: `CLAW-001`, `CLAW-002` and
  `CLAW-006` from [`../test-plan.md`](../test-plan.md) against `--provider hetzner`,
  `--provider digitalocean` and `--provider remote-docker`. Phase 6/7 smoke-tested docker only.
  remote-docker is the one to watch: docker-shaped image and checkpoints, cloud-shaped workspace
  sync, so it is the main consumer of Phase 4's non-git sync leg.

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

## From Phases 6-8 (openclaw as a service agent, 2026-09-02)

- **`AgentSyncSpec.credential` should be optional.** OpenClaw has no host-side credential at all —
  its gateway token is generated per box and must never leave it — but the field is required, so the
  row names a path nothing writes (`~/.openclaw/agentbox-credential.json`) to make every credential
  mechanism a clean no-op. That is honest but indirect, and it forces a `WATCHED_CREDENTIALS` row in
  ctl for a file that will never exist. Making the field optional touches ~10 shared call sites
  (`agent-descriptor`, `credentials-watcher`, the cloud `agentSpecs()`, the credentials concern, the
  relay fanout, the hub catalog); worth doing when a second credential-less agent appears.
- **`agentbox-ctl reload` does not re-run a service agent's render.** Reload applies the *unit*
  diff, and the render task's definition has not changed when only the overlay block has — so
  editing `openclaw:` needs `agentbox-ctl run-task openclaw-render --force`. Teaching reload to
  re-run a render task whose overlay block changed would make the documented "editing the overlay is
  a live operation" true without the extra step.
- **`agentbox <agent> url` reads the token with a raw `cat` over `provider.exec`.** Fine and
  degradation-safe, but it means the value crosses the exec transport in plaintext output. Nothing
  logs it, and every provider's exec is already an authenticated channel, so this is a note rather
  than a defect.
- **The AGENT column item from Phase 2 is still open**, and now has a real service agent to be seen
  on — `agentbox list` reports nothing for an openclaw box because it has no tmux session. See the
  Phases 2-3 entry above.
- **`--persistent` does not exist yet (Phase 1).** `agentbox openclaw` is exactly the workload that
  needs it: a gateway box will be autopaused and idle-lapsed like any other, and it has no reporting
  agent so every idle heuristic reads it as abandoned. The service-agent command should imply
  `--persistent` once Phase 1 lands.
- **Channel pairing is still unverified end to end.** Carried over from Phase 0: `openclaw channels
  add --use-env` needs a real bot token, and the smoke here stopped at a healthy gateway with no
  channels. Wire one before calling OpenClaw support complete.
