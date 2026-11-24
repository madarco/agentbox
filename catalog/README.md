# AgentBox screens

Every AgentBox screen in one gallery: the web hub, the macOS tray and the CLI,
each taken from the real product on made-up demo data (Acme, in
`fixtures/acme.mjs`). Any screen can be exported at social-post sizes on an
AgentBox-branded canvas.

## Quick start

```bash
cd catalog
pnpm install --ignore-workspace     # its own package, outside the repo's workspace
pnpm screens serve                  # http://127.0.0.1:3124/catalog/screens/
```

`pnpm screens open` opens `screens/index.html` from disk instead. Click a card
for its details: where the screen sits in the product, how it was taken, the
command that takes it again, and a preview of every social format with the
export command to copy.

## Layout

| Path | What |
| --- | --- |
| `screens/catalog.mjs` | One entry per screen: id, title, topic, files, how it was taken. The gallery is built from it. |
| `screens/setups.mjs` | The environments the screens are taken in, and the commands that start them. |
| `screens/template.html` | The gallery page. `pnpm screens` writes `screens/index.html` from it. |
| `fixtures/acme.mjs` | The demo data: projects, workspaces, boxes, approvals, accounts, skills. |
| `fixtures/api.mjs` | Answers every `/api/v1` route the hub pages ask for, from that data. |
| `scripts/fixture-hub.mjs` | The real hub UI (`apps/hub`'s production build) on the fixtures, at 127.0.0.1:3126. |
| `scripts/shoot.mjs` | A hub page screenshot (Playwright, 1440x900 at 2x, clock pinned). |
| `scripts/shoot-tray.mjs` | A tray screenshot: `AgentBoxE2E.app --fixtures`, driven through Accessibility. |
| `scripts/backdrop.mjs` | Redraws a tray menu or alert's see-through material over a light desktop (`shoot:tray` runs it; the bare capture is dark gray). |
| `scripts/shoot-cli.mjs` | A CLI screenshot: the real CLI in a PTY, drawn into a terminal window. |
| `scripts/frame.mjs` | The social canvas, shared by the export and the gallery preview. |
| `scripts/export.mjs` | Writes the social PNGs to `out/social/`. |
| `shots/` | The pictures, by surface: `hub/`, `tray/`, `cli/`. |

Nothing here reads the owner's `~/.agentbox` or touches the hub on 8787: the
fixture hub and the CLI run with a scratch `HOME` under `.cache/`, and the
tray runs as a second app with its own bundle id.

## Add a screen

1. Start the environment it needs (see `screens/setups.mjs`):
   - **Hub page:** `pnpm fixture-hub` and leave it running. It needs
     `apps/hub/.next`; build it with `pnpm --filter @agentbox/hub build` from
     the repo root when `apps/hub` changed.
   - **Tray:** `make e2e-app` in `../agentbox-tray` (builds `AgentBoxE2E.app`)
     and `swift build -c release` in `e2e/tray-driver`, once.
   - **CLI:** `pnpm fixture-hub` running, and a built CLI (`apps/cli/dist`).
2. Take the picture:

   ```bash
   pnpm shoot hub/skills.png /skills
   pnpm shoot hub/boxes.png / --full
   pnpm shoot hub/create-box.png /projects/fx-payments-worker --click "text=Create box"
   pnpm shoot:tray tray/skill-updates.png --press agentbox.footer.skillUpdates
   pnpm shoot:cli cli/ls.png --cols 122 --rows 22 -- ls --global
   ```

   The header of each `scripts/shoot*.mjs` lists its options: steps such as `--click`, `--fill` and `--wait-for` for the hub,
   `--press <ax id>` and `--alert` for the tray, `--send '<Down>'` for the CLI.
   `pnpm shoot:tray` takes the screen for a moment: it waits until the Mac has
   been idle for 3 seconds, so leave the mouse alone while it runs.
3. Add an entry to `screens/catalog.mjs` with the `hub()`, `tray()` or `cli()`
   helper. Put the exact shoot command in `files[].shoot`, so
   `pnpm screens retake <id>` can take it again.
4. Run `pnpm screens check`. It fails on a missing file, a picture under
   `shots/` that no entry lists, a duplicate id or an unknown topic.

If a hub page shows an error or an empty state, the fixture hub's log has an
`unhandled GET /api/v1/...` line and `shoot` warns "answered 404". Add that
route to `fixtures/api.mjs`. The tray's demo data lives in the tray repo
(`Sources/AgentBox/Source/FixtureBoxSource.swift`); keep `fixtures/acme.mjs`
telling the same story.

## Export for social

```bash
pnpm export hub/skills                                  # all four formats
pnpm export tray/skill-updates --format 4x5,16x9
pnpm export cli/install --file 1                        # the entry's second picture (the Hetzner step)
pnpm export hub/usage --crop 0,0,2880,1800              # part of a tall page, in image pixels
pnpm export cli/ls --format 1x1 --no-title
```

Files land in `out/social/<id>-<format>.png`. Set `MARKETING_ASSETS=<folder>`
to also copy them to `<folder>/screens/`. The headline, crop and frame kind
default to the entry's `social` in the catalog.

| Format | Size | For |
| --- | --- | --- |
| `16x9` | 1920x1080 | X, LinkedIn, YouTube, website |
| `1x1` | 1080x1080 | Feed posts |
| `4x5` | 1080x1350 | Instagram and LinkedIn portrait feed |
| `9x16` | 1080x1920 | Reels, TikTok, Shorts, Stories |

A `page` frame (hub screens) puts the picture on a rounded card. A `cutout`
frame (tray menus, terminal windows) keeps the picture's own transparent edge.

## Retake everything

```bash
pnpm screens retake          # every entry
pnpm screens retake hub/     # one surface
pnpm screens retake hub/skills
```

Run it after a UI change, then look at the gallery before posting anything.
An entry with a `check` shows a red warning in the gallery: read it first.
