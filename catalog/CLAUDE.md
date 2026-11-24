# catalog/ — context for Claude Code

The AgentBox screen catalog: hub, tray and CLI screenshots on demo data, plus
the social-size export. README.md covers the commands; read it first.

- **Its own package, outside the pnpm workspace.** Install with
  `pnpm install --ignore-workspace`. Nothing in the repo imports from here.
- **Never use real data.** Every screen runs on `fixtures/acme.mjs`. The fixture
  hub and the CLI shots use a scratch `HOME` under `.cache/`; the CLI's
  `config.yaml` there sets `relay.port: 3126` so it never reclaims the real hub
  on 8787. Don't point anything here at `~/.agentbox`.
- **Tray captures are window captures only** (`screencapture -l <window id>` of
  AgentBoxE2E.app's own windows). Never capture a screen region: it records
  whatever else is on the Mac's screen.
- **A hub page that errors means a missing fixture.** Look for `unhandled` in
  `.cache/fixture-hub.log` and add the route to `fixtures/api.mjs`, shaped like
  the real `/api/v1` response (`apps/hub/app/api/v1/**`).
- **The hub is its production build.** After an `apps/hub` change, rebuild with
  `pnpm --filter @agentbox/hub build` and restart `pnpm fixture-hub`.
- **`scripts/frame.mjs` is injected into the gallery page** as source text: keep
  it self-contained (no imports), and don't declare a top-level `frame` or
  `FORMATS` in `screens/template.html`.
- After any change, `pnpm screens check` must pass.
