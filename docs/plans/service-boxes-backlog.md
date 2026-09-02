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

## From Phase 1 (persistent boxes, 2026-09-02)

- **`--persistent` is not on the agent commands yet.** `create` has it; `agentbox claude|codex|
  opencode|pi` do not, because the shared agent-flag table
  (`apps/cli/src/agents/command/options.ts`) was owned by another box during this phase. The
  capability is still reachable there — `createBox`/`createCloudProvider` fall back to the
  effective `box.persistent`, so `agentbox config set box.persistent true --project` applies to an
  agent create. Add the flag when the agent-command files are free.
- **`../agentbox-tray/CLAUDE.md` not updated.** The plan calls for it (the `GET /api/v1/boxes`
  payload is the tray's contract) but the sibling checkout is not present in this box. The new
  `persistent` field is documented in `apps/web/content/docs/api.mdx`; mirror it into the tray's
  doc from the host.
- **The hub's `destroy` route has no persistent guard.** `agentbox destroy <box> -y` refuses on a
  persistent box, but `POST /api/v1/boxes/{id}/destroy` (the web UI, the tray) tears one down with
  only the client's own confirm. Decide whether the guard belongs behind the API — where every
  front-end inherits it — or stays a client concern.
- **The boot reconcile needs a running relay.** A persistent box comes back when the relay
  daemon starts, so a host where the relay is not installed as a login/launchd unit gets no
  restart. `agentbox hub expose` installs such a unit; a plain dev host may not have one.
- **`selectPersistentBoxesToStart` skips `missing`.** A persistent cloud box whose sandbox the
  provider reaped (rather than stopped) is logged once and left alone — recreating it from the
  record is a Phase 4/5 question (workspace sync), not a reconcile one.
