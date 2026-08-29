# Agents

How a coding agent gets into a box, and why a box carries only one.

This is the steady-state reference — the shape the agent layer has today. The
work plan that got us here (and what is still outstanding) lives in
[`agent-catalog-plan.md`](./agent-catalog-plan.md).

---

## Thesis: an agent is a row of data

An agent used to be a `RUN npm install -g …` line in `Dockerfile.box`, mirrored
into four cloud provision scripts, plus a hand-written `ensure<Agent>Installed`
per tool. Adding one meant editing all of them and keeping them in step.

Now each agent is one entry in **`AGENT_SYNC_SPECS`**
(`packages/sandbox-core/src/sync/registry.ts`), and that entry carries an
`install` recipe alongside the sync/credential data it already had:

```ts
{
  id: 'codex',
  binary: 'codex',                       // probe: `command -v codex`
  install: {
    recipe: { kind: 'npm', package: '@openai/codex' },
    runAs: 'root',
    apt: ['bubblewrap'],
    postInstall: '…dirs, symlinks, ownership…',
  },
  // …sessionName, dockerVolume, staticPaths, credential, caps
}
```

**One recipe, two execution sites** (three once the cloud half lands):

| site | what runs it | when |
|---|---|---|
| derived image layer | `buildDerivedAgentImage` (`sandbox-docker/src/image.ts`) | `agentbox <agent>` on docker |
| live box | `ensureAgentInstalled` (`sandbox-core/src/sync/concerns/install.ts`) | adding an agent to a running box |
| cloud provision script | `install-box.sh` / `provision.sh` / `build-template.sh` | **not yet** — these still hardcode `npm install -g @openai/codex opencode-ai` |

Keep the sites in step by keeping the *data* in one place — never by copying an
install into a second file. The cloud scripts are the one remaining copy, and
closing that is part of the cloud work.

### Recipe fields that matter

- **`runAs`** is not a detail. Claude's native installer writes into the
  *invoking* user's `~/.local/bin`, so running it as root puts `claude` in
  `/root` and the box user never sees it. `npm install -g` is the opposite and
  needs root.
- **`postInstall`** owns the agent's home + credential dirs (`~/.claude`,
  `~/.codex`, `~/.agentbox-creds/<agent>/` and the symlinks that pivot each
  agent's credential path into a mounted volume). It lives here, not in the
  Dockerfile, so every install site produces the same layout.
- **`alternates`** are other ways to install the same agent, keyed by mode.
  Only `npm` is used: `box.claudeInstall: npm` is the escape hatch for hosts
  whose egress IP the Claude CDN 403s.
- **`script` recipes fetch to a file and run it with `bash`.** Not `curl | bash`
  — piping hides a blocked download behind bash's exit 0 — and not `sh`, because
  `/bin/sh` is dash on Debian/Ubuntu and these installers are bash scripts.

---

## One agent per box

`agentbox claude` produces a box containing **claude and nothing else** — its
binary, its config volume, its credentials, its home dir. No codex or opencode
login is anywhere in that box.

`createBox({ agents })` is the authoritative selection. Omitted, it falls back to
the historical behaviour (mount whatever the host happens to have) so an
un-migrated caller keeps working.

| | |
|---|---|
| `agentbox claude` | `agents: ['claude']` |
| `agentbox codex` / `opencode` | likewise |
| a queued `-i` job | `[toSyncKind(job.agent)]`, or `[]` for `--no-agent` |
| `agentbox create` | `[]` — no agent |

The shared `~/.agents` skills volume is still mounted for every box: it is
agent-neutral and carries no auth.

---

## Image tiers

```
Dockerfile.box ──prepare/pull──▶ agentless base            agentbox/box:dev
                                        │
                                        ▼ FROM + install recipe
                                   agent layer             agentbox/box:dev-claude
                                        │
                                        ▼ docker commit
                                 project checkpoint        agentbox-ckpt-<hash>:<name>
```

The base carries **no agents**. Each agent is added as a thin `FROM <base>`
layer, not a second full build, because the agent installs would otherwise have
to sit above Playwright, Chromium and the VNC stack — so every one of those
layers would diverge per agent:

| | full variant build | derived layer |
|---|---|---|
| `dev-claude` unique | 1.279 GB | **434 MB** |
| `dev-codex` unique | 1.518 GB | **702 MB** |
| base | 2.23 GB shared | **3.07 GB, fully shared** |

It also means CI publishes **one** image rather than one per agent set.

Timings on a warm layer cache: base 56s, `+claude` 23s, `+codex` 21s, repeat
`claude` 0s.

### Fingerprints and prepared records

- `variantFingerprint(baseSha, { claudeInstall, agents })` folds the build
  variant into the image identity. **The empty variant is the identity fold**, so
  the plain base keeps the raw context hash and a provider that passes no
  variant is unaffected. `claudeInstallFingerprint` is left alone — it ships in
  the published provider SDK.
- `variantImageRef` gives each set its own local tag (`…:dev-claude`), so two
  boxes built for different agents can't overwrite one another's image.
- `docker-prepared.json` keeps **one record per variant**. It also stamps `base`
  with the most recently prepared image for `prepare --status` and custody, so
  **read `preparedShaFor(state, variant)`, never `state.base` directly** — after
  any agent bake `base` holds a *variant* hash, and comparing the agentless
  fingerprint against it reports a spurious `stale`.

---

## Adding an agent to a running box

Point a second agent at an existing box (`agentbox codex <claude-box>`, or the
dashboard's agent switch) and it is installed on demand.

The binary install is the easy half. The subtle half is credentials: **docker
fixes a container's mounts at `docker run`**, so the new agent's config volume
can never be attached to a box that is already running. Syncing the host-side
volume would write somewhere the box cannot see and leave the agent
unauthenticated with no visible error.

So `ensureAgentInstalled` pushes the credential **as a file** over the
`SyncTransport` (`pushCredentialToBox`), preferring the `~/.agentbox` backup —
the fan-out's newest-wins copy — over the tool's real path, and shape-validating
so a half-written file counts as absent. This is not a workaround: it is what
every cloud provider already does on each create (`TransportCaps.ephemeralFs`),
and the credential watcher plus `extractAgentCredentials` still carry any
resulting login back to the host.

Because it runs over `SyncTransport` rather than `docker exec`, this is also the
first time a **cloud** box booted from a snapshot that predates an agent can get
that agent at all.

### Root escalation across seams

Docker honours `exec --user root`; cloud backends run as the box user by name and
generally ignore it. One string covers both:

```sh
if [ "$(id -u)" = 0 ]; then <cmd>; else sudo -n sh -c "<cmd>"; fi
```

`sudo -n` never prompts, so a box without a sudo grant fails fast with a usable
message instead of blocking on a password read nothing will answer.

---

## Adding a new agent

1. **Add the row** to `AGENT_SYNC_SPECS`: `id`, `binary`, `install`
   (recipe + `runAs` + any `apt` + `postInstall`), `sessionName`,
   `dockerVolume`, `staticPaths`, `credential`, `forwardedEnvKeys`, `caps`.
   Keep it JSON-serializable — no closures — so the descriptor can later be
   shipped into a box whose `agentbox-ctl` was baked before the agent existed.
2. **Open the identity unions**: `AgentId`, `SyncAgentKind`/`QueueAgentKind`
   (`packages/core/src/sync/agent-kind.ts`).
3. **Add the CLI command** — today a clone of `apps/cli/src/commands/opencode.ts`
   (the smallest of the three), registered in `index.ts`, `attach.ts`,
   `agent-sessions.ts`, `list.ts` and `argv-prefix.ts`.
4. **Config keys**: `<agent>.sessionName` and `box.isolate<Agent>Config` in
   `packages/config`.
5. **ctl**, if the agent should report activity: a `BoxStatus` field, an
   `<agent>-state` op, and a `WATCHED_CREDENTIALS` entry (drift-tested against
   the registry).

Nothing in step 1 requires touching `Dockerfile.box`. Steps 3–5 are the tail
that a future `agentCommand(spec)` factory and a generic ctl status map would
collapse — see the seam analysis in
[`agent-catalog-plan.md`](./agent-catalog-plan.md).

---

## Provider status

| | docker | cloud (hetzner, vercel, e2b, daytona, DO) |
|---|---|---|
| agentless base | yes | no — the provision scripts still install all three |
| agents as a derived layer/snapshot | yes | not yet |
| per-box agent selection | yes | not yet — cloud still mounts every agent's volume |
| on-demand install into a live box | yes | yes |

Cloud behaviour is therefore unchanged from before this work, and
`ensureAgentInstalled` is a no-op there because the snapshot already has the
agent. Derived snapshots (boot base → install → re-snapshot) and cloud-side
selection are the outstanding half.
