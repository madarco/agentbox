# Remote-hub improvements — workstream plan

Source backlog: [`remote-hub-backlog.md`](./remote-hub-backlog.md) (16 items).

The 16 items are grouped into 5 workstreams so they can be implemented in parallel
sandboxes with minimal file overlap. Each workstream is one branch + one PR against
`feat/remote-hub-improvements`.

Wave 1 (parallel): WS1, WS3, WS4 — disjoint file sets (CLI setup / hub UI pages / hub UI polish).
Wave 2 (after wave 1 merges): WS2, WS5 — both re-touch `apps/cli/src/commands/control-plane.ts`.

---

## WS1 — `hub setup` CLI UX (backlog 7, 8, 9, 10, 12, 15)

Primary files: `apps/cli/src/commands/control-plane.ts`,
`apps/cli/src/control-plane/github-app-manifest.ts`, `apps/web/content/docs/deployed-hub.mdx`.

- **12** — `hub setup` description becomes `Set up a persistent remote Hub for your AgentBoxes`.
  Drop the GitHub-App wording from the group/`hub` description too.
- **7** — after a deploy, `Control plane is healthy (<url>/healthz).` is noise. Replace with a
  terse `✔ Healthy` (keep the failure branch informative — it must still name the URL).
- **8** — `hub setup` must fail fast when `gh` is not on PATH: a preflight doctor check at the very
  top of the action, before any App/deploy work, with an install hint. `gh` is mandatory for the
  remote hub (the control box leases push tokens through it).
- **9** — hide the GitHub-App path from the surfaced UX: no `app` option in the interactive
  `--git-auth` prompt, no App wording in help/notes. The `--git-auth app` flag itself stays working
  (hidden), we just stop advertising it.
- **10** — hide the Vercel option from the interactive deploy picker (`--deploy vercel` still works).
- **15** — the local OAuth callback pages served by `github-app-manifest.ts` (the redirect-to-GitHub
  page and the `…/callback` success page) are unstyled `<h2>` HTML. Give both a small self-contained
  styled page (AgentBox dark palette, system font, centered card, light/dark aware). No external assets.

## WS2 — DigitalOcean deploy target (backlog 11)

Primary files: new `apps/cli/src/control-plane/deploy-digitalocean.ts`, hooks in
`apps/cli/src/commands/control-plane.ts`, docs.

- **11** — add a `digitalocean` deploy target to `hub setup --deploy` / `hub deploy`, shaped like the
  existing Hetzner one (`deploy-hetzner.ts` + `runHetznerDeploy`/`Update`/`Destroy`): provision a
  Droplet, cloud-init the docker-compose hub, HTTPS via `<ip>.sslip.io` + Caddy, firewall locked
  down, deploy record written the same way. Reuse `hub-deploy-assets` where possible.

## WS3 — hub web UI: custody + build/version pages (backlog 3, 4)

Primary files: new pages under `apps/hub/app/(dashboard)/`, new `/api/v1` routes,
`apps/hub/components/app-sidebar.tsx`.

- **3** — a Custody page: list what the control box holds (agent credentials, project seeds,
  prepared bakes, SSH keys) with paths + hashes + sizes. Values are never returned — same contract
  as `agentbox hub custody list`.
- **4** — a Build/System page: hub version, git sha, deploy channel/source, which providers are
  baked (and the bake fingerprint / why a re-bake is needed), and the skills/agents baked into the
  image. Enough to answer "do I need to re-bake?" without a terminal.

Both pages are pure REST clients over new `/api/v1` routes (no server actions) — see
`feedback-hub-web-pure-rest-client`.

## WS4 — hub web UI polish (backlog 5, 6, 14, 16)

Primary files: `apps/hub/app/(dashboard)/projects/[id]/page.tsx`,
`apps/hub/lib/boxes/postgres-source.ts`, `apps/hub/app/(auth)/signin/page.tsx`,
`apps/hub/components/topbar.tsx` / `hub-shell.tsx`. **Do not touch `app-sidebar.tsx`** (WS3 owns it).

- **5** — project detail page shows the real details: repo URL, custody/seed status, provider,
  default branch, last seed push, secrets present.
- **6** — a project added on the remote hub gets a readable name (last path segment / repo name),
  matching the local hub, instead of a slug/base64 key.
- **14** — the sign-in page of a *deployed* hub renders no logo. Find out why (`public/` staging in
  the deploy image vs. the standalone build) and fix it so the mark shows.
- **16** — when this machine's local hub is linked to a remote hub (`relay.controlPlaneUrl` set),
  show a banner at the top of the local hub: "This AgentBox instance is linked to <remote hub>",
  with a link.

## WS5 — credentials + bake state after `hub setup` (backlog 1, 2)

Primary files: `apps/cli/src/commands/control-plane.ts`,
`apps/cli/src/control-plane/prepared-custody.ts`, `apps/hub/lib/prepared-hydrate.ts`.

- **2** — `hub setup` must end by pushing agent credentials to custody (`hub credentials push`), so a
  hub-created cloud box is never launched without a Claude login. Also re-push when the host
  credential changes (hash-based, see `feedback-credential-change-detection`) rather than only once.
- **1** — after `hub setup`, locally-baked providers should be reflected on the control box: push the
  local prepared records to custody so the hub shows them baked. When the fingerprints cannot match
  (different build context / env), say so explicitly at the end of setup: "providers are configured
  but will need baking again", naming which.

## Item 13 (rename `hub prompts` → `hub approvals`)

Folded into WS1 — it is the same file, and "approvals" is the terminology the tray and the local hub
already use.
