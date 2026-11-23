# Agent env on the VPS providers (hetzner, digitalocean)

## Problem

The SDK providers hand the agent env to the sandbox as a whole (daytona `envVars`,
vercel `env`, e2b `envs`, remote-docker `docker run -e`). A VPS can only carry env
through cloud-init `user_data`, which the cloud API stores and any in-box process can
read back from the metadata service, so `cloudInitBoxEnv` keeps only the non-secret
`AGENTBOX_*` keys. That filter also dropped the non-secret agent run-env
(`boxRunEnv`), and nothing else carried the secrets either:

- opencode lost `OPENCODE_CONFIG_DIR` / `XDG_STATE_HOME`: host config, providers, MCP
  and plugins were ignored, and the `agentbox-state` plugin never loaded (activity
  always `unknown`);
- pi lost `PI_SKIP_VERSION_CHECK`;
- every agent lost its forwarded keys (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `OPENAI_API_KEY`, ...), and a named LLM account with a pasted token / API key
  started unauthenticated.

`box.env` is no fix: it is world-readable, and `kickCloudBootstrap` rewrites it on
every create and wake.

## Phase 1: boxRunEnv on the launch command (done)

`buildCloudAttachInnerCommand` exports `resolveAgentSpec(binary).boxRunEnv`, the TUI
env winning over it on a clash. That one builder serves all three launch paths
(`_cloud-attach.ts`, `dashboard.ts`, `detached-agent.ts`). Harmless on the SDK
providers, which already have the same values sandbox-wide.

## Phase 2: secrets in a 0600 `/run/agentbox/agent.env` (done)

- `buildCloudAgentEnv(agents, accounts)` (sandbox-cloud) is the env a box's agents
  get: `boxRunEnv` + the host's forwarded keys + named-account env (`accountEnv`).
  Model-auth `env` sources are forwarded keys too, so they ride the same map. It is the
  same map create already passed to `provision`.
- `writeCloudAgentEnvFile` writes it as `[ -n "${KEY+x}" ] || export KEY='value'`
  lines: a key the environment already has is left alone. The file is rebuilt from the
  env of whichever process wakes the box, so without this a wake from a shell exporting
  `ANTHROPIC_API_KEY` would move a subscription-authed daytona/vercel/e2b/remote-docker
  box onto that key (or stall it on claude's "use this API key?" prompt). Those
  providers keep their create-time sandbox env; a VPS, which has none, still gets every
  key.
- A local 0600 temp file is uploaded straight into `/run/agentbox/` (tmpfs, so a copy
  left by a failed move never reaches a snapshot; scp keeps the 0600 mode), falling
  back to `/tmp` when an SDK upload runs as a user that cannot write there. `install -m
  600` then moves it to `/run/agentbox/agent.env`, owned by the box user. The values
  never reach an argv, `user_data` or `box.env`.
- Written at create, after the bootstrap kick, and on every wake (`reEnsureCloudBox`),
  because a hetzner/DO stop is a power-off and `/run` is tmpfs. Both are best-effort and
  log a warning without the values; a failed create-time write also removes any
  `agent.env` a checkpoint carried in, so a stale copy is never sourced. Same file on
  every cloud provider, written through the shared path.
- The launcher sources it (`set -a`) before its own exports, so the TUI env and
  `boxRunEnv` still win.

### credentialSync on wake

The bootstrap kick now exports `AGENTBOX_CREDENTIAL_SYNC=0` when `box.credentialSync`
is false. On a VPS that flag only rode cloud-init `box.env`, which the kick
overwrites, and the daemon starts from a non-login `bash -c` that never sources it, so
the ctl credential watcher ran on hetzner/DO even when it was turned off.

## Backlog

- The wake path reads `box.credentialSync` from config (the same rule the resume-time
  credential reconcile uses), so a `--no-credential-sync` create override is lost on a
  VPS wake. Fixing it means persisting the resolved value on the box record.
- On vercel/e2b/daytona the SDK upload writes the staging copy with its default
  mode (0644) for the moment before the in-box step chowns it to the box user and
  chmods it 600. Those providers already hold the same values in every process's
  environ, so the window adds nothing an in-box process couldn't already read. The
  staging copy is always removed (both `/run/agentbox` and `/tmp` paths), and each
  write sweeps copies older than a minute that an earlier failed write left behind;
  this matters on daytona, where `/run` is not tmpfs and a checkpoint would carry one.
- A wake rebuilds `agent.env` from the env and account store of the process that
  starts the box (normally the hub, which also ran the create). On a VPS, a start from a
  process without the forwarded keys writes the file without them, and the agent comes
  back unauthenticated. (On the SDK providers the create-time sandbox env still wins.) Before this change a VPS box never got those keys at all, so
  this is not a regression; the fix is to keep the create-time values (encrypted, or
  only rewriting keys the waker actually has).
- Only the TUI launcher sources `agent.env`. A service agent (openclaw) runs under the
  ctl supervisor's env, so on a VPS a named account's token for it still does not
  arrive (64588067 fixed only `boxRunEnv` for its units). openclaw forwards no host keys
  today.
- An agent added to a live box (`ensureAgentInstalled`) gets no `agent.env` entries
  until the next wake.
- `agentbox <agent> -i ... --account <name>` still runs the default-login precheck
  (`assertAgentCredsAvailable`), so with no default login and no host env key it fails
  with "No Claude credentials on host" even though the named account would
  authenticate the box. Pre-existing, every provider.
- Found during the live check, digitalocean provider: `destroy` left the per-box
  firewall (and its tag) behind for a box whose `-i` session check failed. It finds the
  firewall from the droplet's tags before deleting the droplet, and that lookup came up
  empty. Deleted by hand. Pre-existing and unrelated to the agent env.

### LATER

- A VPS that reboots outside agentbox (a provider-side restart, `sudo reboot` in the
  box) loses `/run`, yet still probes as running, so the next attach runs without
  `agent.env`, and so without the keys, until a stop/start goes through
  `reEnsureCloudBox`.
- No wiring or integration test covers the create / start / reconnect paths that write
  `agent.env`; only the builder, renderer and writer are unit-tested.
- `@madarco/agentbox-provider-sdk` inlines `@agentbox/sandbox-cloud`, so community
  providers get this fix only after an SDK republish (version bump; no
  `SDK_API_VERSION` change, the interface is unchanged).

## Live check (2026-11-23, isolated hub on :8799)

- hetzner, opencode: the agent process has `OPENCODE_CONFIG_DIR`, `XDG_STATE_HOME` and
  the forwarded keys; opencode loads its config dir (plugins, skills, `opencode.json`)
  and the box payload reports `opencodeActivity: idle` (was `unknown`).
- hetzner and digitalocean, claude with a named API-key account (dummy key): the account
  key is in the claude process env and the host's key is not; the key is in no
  `/proc/*/cmdline`, not in `box.env`, not in the metadata `user_data`; `agent.env` is
  0600 vscode and no `/tmp` staging copy is left.
- hetzner wake (power-off + start): `agent.env` is rewritten, and the ctl daemon has
  `AGENTBOX_CREDENTIAL_SYNC=0` with `box.credentialSync: false`.
