# Docs images — capture guide

How to (re)produce every screenshot the docs need, from **one** test environment.
Read top to bottom: provision the environment once (Section 1), keep the tooling
handy (Section 2), then sweep the catalog in phase order (Section 3) so you barely
switch context.

Images live in `apps/web/public/screenshots/` and are referenced from
`<Figure src="/screenshots/<name>.png" />` in `content/docs/*.mdx`. Line numbers
below are approximate — **match figures by caption**, not line.

Use the /screenshot skill to capture screenshots of terminal windows and GUI windows.

## Status

| Image | Used by (doc figures) | Status | Phase |
|-------|------------------------|--------|-------|
| `web-app.png` | web-apps-and-tunnels | done (2026-06-02, wrapped in a browser chrome showing the web.localhost address bar) | A |
| `novnc-desktop.png` | access-your-box, browser-and-screen | done (2026-06-02, in-box browser shows the app; wrapped in a fake browser chrome → browser-in-browser) | A |
| `agentbox-ls.png` | background-and-parallel | done (2026-06-02, recaptured) | B |
| `dashboard.png` | access-your-box, background-and-parallel, cli | done (2026-06-02, recaptured) | C |
| `claude-tui.png` | run-an-agent, cli | done (2026-06-02) | C |
| `cursor.png` | access-your-box (Cursor / Dev Containers) | done (2026-06-02) | C |
| `push-approval.png` | sync-and-git (push approval) | done (2026-06-02, gh pr create approval band, agent-driven) | C |
| diagram — core-concepts | core-concepts (box/relay model) | done (2026-06-02, `/diagrams/core-concepts.png`, nano-banana-pro) | D |
| diagram — configuration | configuration (resolution order) | done (2026-06-02, `/diagrams/configuration.png`, nano-banana-pro) | D |
| diagram — services DAG | services-and-tasks (`needs` DAG) | done (2026-06-02, `/diagrams/services-and-tasks.png`, nano-banana-pro) | D |
| diagram — sync/git | sync-and-git (commits land / relay) | done (2026-06-02, `/diagrams/sync-and-git.png`, nano-banana-pro) | D |
| diagram — teleport | teleport-a-project (repo → branch) | done (2026-06-02, `/diagrams/teleport-a-project.png`, nano-banana-pro) | D |
| `hetzner_api.jpg` | hetzner (API token console) | done (2026-06-02, captured manually from the Hetzner console) | E |

---

## 1. Test environment (provision once)

The base project is `examples/express-ready` — its `agentbox.yaml` declares an
`install` task and a `web` service on **port 3000** (exposed at
`https://<box>.localhost`) with a `ready_when` probe, so each box auto-runs a real
web app. That covers the web-app, noVNC, services, dashboard, and ls shots.

```bash
# 1) Destroy every existing box (clean slate)
for ref in $(agentbox ls --global --json | jq -r '[.. | .id? // empty] | unique[]'); do
  agentbox destroy "$ref" -y
done
agentbox ls --global         # confirm empty (also check: docker ps | grep agentbox-)

cd examples/express-ready
```

**Hero box** (`web`, docker) — launch it **attached in its own iTerm window**. An
attached, live Claude session is what the dashboard mirrors and what noVNC
reflects (a background `-i` run is not live-mirrorable):

```bash
osascript \
  -e 'tell application "iTerm" to activate' \
  -e 'tell application "iTerm" to set b to (create window with default profile)' \
  -e 'tell application "iTerm" to set bounds of b to {60, 90, 1160, 770}' \
  -e "tell application \"iTerm\" to tell current session of b to write text \"cd $PWD && AGENTBOX_CARRY=skip agentbox claude --provider docker -n web --attach-in same\""
```

> **Two gotchas, both load-bearing for a clean capture (learned the hard way):**
> 1. **`--attach-in same`** is mandatory. Without it the default is
>    `attach.openIn=split`, so `agentbox claude` *splits the launching window* —
>    the launching shell stays on the left, the Claude TUI on the right. That
>    split is what looks like "opened in a tab." `same` makes the agent take
>    over the whole window (one clean full-window TUI). `create window` already
>    makes a real new window; the split came from the attach, not the window.
> 2. **Set `bounds` before `write text`** so the TUI renders at the target size
>    from the first paint (resizing a live TUI afterwards can leave reflow
>    artifacts). `{60,90,1160,770}` ≈ 1100×680, a good 16:10-ish frame.
> 3. **`AGENTBOX_CARRY=skip`** — `express-ready` declares an `optional` `carry:`
>    block; without the marker staged it prompts, and a non-interactive/scripted
>    launch hangs on that prompt. Skip it (or stage the marker + `--carry-yes`).

Give the hero box a real task (`express-ready` is a tiny Express HTTP server, so
"improve the home page" produces a visible result for the web-app and noVNC shots).
Send the prompt into the box's `claude` tmux session (same trick used to `/clear`):

```bash
SESS=$(docker exec agentbox-web bash -lc "tmux ls 2>/dev/null | grep -i '^claude:' | head -1 | cut -d: -f1")
docker exec agentbox-web bash -lc "tmux send-keys -t '${SESS:-claude}' 'Improve the home page of this Express app — turn it into a clean landing page, then restart the web service so the change is live.' Enter"
```

**Two more boxes across providers**, with background tasks (they show
`claude:working` in `ls`/dashboard; provider variety for the `ls` shot). One is a
**plan** so the dashboard/ls can show an agent in plan mode:

```bash
# IMPORTANT: cloud -i jobs run in a queue worker whose cwd is NOT yours, so pass
# an ABSOLUTE -w path. A relative -w (e.g. examples/express-ready) makes the
# workspace `tar -C <rel>` fail with "could not chdir" and the create aborts
# (after provisioning — see the orphan-cleanup note below). Docker tolerates a
# relative -w; the cloud seeders do not.
PROJ="$PWD"   # if you `cd examples/express-ready` first; else give the full path
AGENTBOX_CARRY=skip agentbox claude --provider hetzner -n api   -w "$PROJ" -i "Plan a todo app: write a detailed implementation plan. Don't write any code yet."
AGENTBOX_CARRY=skip agentbox claude --provider vercel  -n cloud -w "$PROJ" -i "Add a /health endpoint to server.js that returns 200 OK."

agentbox ls --global         # web (docker, improving the home page) + api (hetzner, planning) + cloud (vercel)
# -i jobs are queued; watch ~/.agentbox/logs/queue-<id>.log for FAIL/END. A
# failed cloud create can orphan a VPS/firewall — if a job FAILs, verify with
# `curl -H "Authorization: Bearer $HCLOUD_TOKEN" https://api.hetzner.cloud/v1/servers`
# (delete any leftover server; unattached firewalls, applied_to=0, are free).
```

> Let the **`web`** agent finish "improve the home page" (and the service restart)
> before the Phase A captures below — the web-app and noVNC shots should show the
> *new* home.

**Cleanup (after all captures):**

```bash
agentbox destroy web api cloud -y
```

Close only the iTerm windows **you** opened (by id — see the caveat below). Never
touch your own session window.

---

## 2. Tooling

### 2a. Terminal render (clean, on-brand card)

For command output (e.g. `agentbox ls`) rendered in the docs' dark-terminal style.
Write this helper to `/tmp/gen-term.js`:

```js
// Render captured terminal output into an on-brand "terminal" HTML card.
// usage: node gen-term.js <output.txt> "<command label>" <out.html> [title]
const fs = require('fs');
const [, , outFile, cmd, htmlFile, titleArg] = process.argv;
const title = titleArg || 'agentbox — zsh';
const raw = fs.readFileSync(outFile, 'utf8')
  .split('\n').map((l) => l.replace(/\s+$/, '')).join('\n') // trim per-line padding (TUI captures)
  .replace(/\n{3,}/g, '\n\n') // collapse big blank runs
  .replace(/^\n+|\n+$/g, '');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const body = `<span class="pr">$ </span><span class="cmd">${esc(cmd)}</span>\n` + esc(raw);
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0}
  body{background:#f6f6f3;padding:46px;font-family:"IBM Plex Mono",ui-monospace,monospace}
  .term{max-width:980px;margin:0 auto;background:#15171b;border:1px solid #262a31;border-radius:10px;overflow:hidden;
    box-shadow:0 20px 44px -28px rgba(20,24,30,.5),0 2px 8px -3px rgba(20,24,30,.22)}
  .bar{display:flex;align-items:center;gap:6px;padding:11px 14px;background:#1b1e24;border-bottom:1px solid #262a31}
  .d{width:11px;height:11px;border-radius:50%}
  .r{background:#ec6a5e}.y{background:#f4bf4f}.g{background:#61c554}
  .title{margin-left:9px;font-size:12px;color:#6c727b;letter-spacing:.02em}
  pre{padding:18px 18px 20px;font-size:14.5px;line-height:1.75;color:#c8ccd3;white-space:pre;overflow:auto}
  .pr{color:#4ec98a}.cmd{color:#f0f2f5}
</style></head><body>
<div class="term"><div class="bar"><span class="d r"></span><span class="d y"></span><span class="d g"></span><span class="title">${esc(title)}</span></div>
<pre>${body}</pre></div></body></html>`;
fs.writeFileSync(htmlFile, html);
console.log('wrote', htmlFile);
```

Then capture (playwright-cli blocks `file://`, so serve over http):

```bash
agentbox ls > /tmp/out.txt
node /tmp/gen-term.js /tmp/out.txt "agentbox ls" /tmp/term.html "agentbox — zsh"
( cd /tmp && python3 -m http.server 8899 >/dev/null 2>&1 & )
playwright-cli session-stop-all
playwright-cli --session=t open "http://localhost:8899/term.html"
playwright-cli --session=t resize 1100 430        # size to fit the card
playwright-cli --session=t screenshot             # prints the saved PNG path
lsof -ti tcp:8899 | xargs kill -9
```

Copy the printed PNG into `apps/web/public/screenshots/<name>.png`.

### 2b. Real window capture (color, authenticity)

Use the screenshot skill for colored TUIs (dashboard, Claude) and GUI apps (Cursor):

```bash
# The skill scripts live under the agents-skills dir, NOT .claude/skills:
SK=~/.agents/skills/screenshot/scripts
bash "$SK/ensure_macos_permissions.sh"                      # once
python3 "$SK/take_screenshot.py" --list-windows --app "iTerm"   # find the window id
python3 "$SK/take_screenshot.py" --mode temp --window-id <ID>   # capture that window only
```

> The `/screenshot` skill resolves the same scripts; if you shell out directly,
> use `~/.agents/skills/screenshot/scripts` — the old `.claude/skills/...` path
> does not exist on this host. `--mode temp` prints the saved PNG path to stdout.

> **Caveat — capture by `--window-id`, never `--active-window` / "front window".**
> Focus-based capture can grab (and resizing osascript can *resize*) your own
> Claude session window. Always `--list-windows` first and target the id of the
> `AgentBox: …` window.

### 2c. Crop (drop the iTerm status bar / window chrome)

```bash
python3 - <<'PY'
from PIL import Image
im = Image.open("/tmp/<shot>.png")
w, h = im.size
im.crop((0, 0, w, int(h * 0.92))).save("apps/web/public/screenshots/<name>.png")  # tune 0.92
PY
```

For the dashboard/Claude windows: `/clear` the Claude pane first (removes the
"Remote Control failed…" startup line) — send it via tmux like the task prompt
above, or type it.

---

## 3. Image catalog — capture in this order

### Phase A — Headless browser (boxes running)

**`web-app.png`** → web-apps-and-tunnels. The improved Express home page at
`<box>.localhost` (capture after the `web` agent finishes), then wrapped in a
fake browser chrome so the `https://web.localhost` address bar is visible (the
figure is about the URL story).

```bash
agentbox url web --print          # -> https://web.localhost
playwright-cli --session=b open "https://web.localhost"
playwright-cli --session=b resize 1100 720
playwright-cli --session=b screenshot   # raw page -> /tmp/webapp-inner.png
```

> **Then wrap it in a browser frame** (same on-brand chrome as `novnc-desktop`,
> minus the browser-in-browser nesting): one tab (`hello from agentbox`, green
> favicon), an address bar showing `🔒 https://web.localhost`, a star. Build the
> HTML wrapper (`/tmp/webapp-frame.html`, `<img src="webapp-inner.png">`), serve
> over http, `playwright-cli resize 1196 920 && screenshot`, crop to `1196x898`
> (even 44px paper margin). Reuse the `novnc-frame.html` markup — only the tab
> label, the address `host`, and the inner image change.

**`novnc-desktop.png`** → access-your-box, browser-and-screen. The box desktop with
the in-box Chromium showing the box's web app.

**Capture this LAST**, on the **`web`** box, once "improve the home page" has
finished — so the desktop shows the new landing page. `agentbox screen` both prints
the noVNC URL **and** launches an in-box Chromium pointed at the box's web app
(`localhost:3000`), so the desktop already has the app on screen.

```bash
agentbox screen web --print       # starts the in-box Chromium on the app; prints https://web.localhost/vnc.html?autoconnect=1&password=...
playwright-cli --session=v open "<that URL>"
# wait ~5s for the noVNC canvas to connect and Chromium to paint the home page, then:
playwright-cli --session=v resize 1044 800
playwright-cli --session=v screenshot   # raw 1044x800 desktop canvas -> /tmp/novnc-inner.png
```

> **Then wrap it in a fake browser chrome (browser-in-browser).** The raw canvas
> alone doesn't read as "noVNC in your host browser," so the final
> `novnc-desktop.png` nests the desktop capture inside an on-brand browser frame
> (traffic lights + a `web — Desktop (noVNC)` tab + an address bar showing
> `https://vnc-web.localhost/vnc.html?autoconnect=1&password=••••••`). The result
> shows the box's own Chromium *inside* the host browser tab. Build it the same
> way as the §2a terminal card — an HTML wrapper served over http, screenshotted
> with playwright:
>
> ```bash
> cp apps/web/public/screenshots/novnc-desktop.png /tmp/novnc-inner.png  # the raw canvas
> # write /tmp/novnc-frame.html: a .win card (rounded, shadow) on paper #f6f6f3 with
> #   a tab strip (3 traffic lights + green-favicon tab) + a toolbar (nav glyphs +
> #   address pill, green lock) + <img src="novnc-inner.png">. Accent #128a4f, IBM Plex.
> ( cd /tmp && python3 -m http.server 8899 >/dev/null 2>&1 & )
> playwright-cli --session=f open "http://localhost:8899/novnc-frame.html"
> playwright-cli --session=f resize 1140 1000 && playwright-cli --session=f screenshot
> # crop to 1140x978 (even 44px paper margin) -> novnc-desktop.png
> ```

### Phase B — Rendered terminal

**`agentbox-ls.png`** → background-and-parallel. `agentbox ls` with web/api/cloud
across docker/hetzner/vercel, agents working. Use the render flow in §2a; viewport
~`1100 430`.

### Phase C — Real terminal / app windows (skill + crop)

**`dashboard.png`** → access-your-box, background-and-parallel, cli. Open the
dashboard pre-selected on the hero box (its live Claude shows in the right pane):

```bash
# Create the window, SIZE IT, then launch — capturing its id so the resize and
# capture never touch "front window" (which could be your own session). The
# dashboard is a single TUI (no attach), so it takes over the window cleanly —
# no --attach-in needed here.
WID=$(osascript \
  -e 'tell application "iTerm" to activate' \
  -e 'tell application "iTerm" to set b to (create window with default profile)' \
  -e 'tell application "iTerm" to set bounds of b to {40, 80, 1320, 600}' \
  -e "tell application \"iTerm\" to tell current session of b to write text \"cd $PWD && agentbox dashboard web\"" \
  -e 'tell application "iTerm" to id of b')
echo "dashboard window id=$WID"      # use this exact id for --window-id below
# /clear the claude pane (removes the startup warning); then capture by $WID -> crop bottom ~8%.
```

**`claude-tui.png`** → run-an-agent, cli. The Claude Code TUI inside the box. Do
**not** reuse the hero window if it came up as a split — open a dedicated
full-window attach instead (`--attach-in same` takes over the window; the box's
live session is unchanged by detach/reattach):

```bash
WID=$(osascript \
  -e 'tell application "iTerm" to activate' \
  -e 'tell application "iTerm" to set b to (create window with default profile)' \
  -e 'tell application "iTerm" to set bounds of b to {60, 90, 1160, 770}' \
  -e "tell application \"iTerm\" to tell current session of b to write text \"cd $PWD && agentbox claude attach web --attach-in same\"" \
  -e 'tell application "iTerm" to id of b')
echo "claude window id=$WID"
# /clear first; capture by $WID; crop window chrome / status bar (~8%).
```

**`cursor.png`** → access-your-box (Cursor / Dev Containers).

```bash
agentbox code web --ide cursor    # opens Cursor attached to the box's /workspace
# Dev Container attach takes ~30-60s. Wait until the box-attached window's
# WORKSPACE tree populates (title: "workspace [Container agentbox-web (…)]" and
# the green "Container agentbox-web" badge bottom-left) before capturing.
SK=~/.agents/skills/screenshot/scripts
WID=$(python3 "$SK/take_screenshot.py" --list-windows --app "Cursor" | grep -i 'container agentbox-web' | head -1 | awk '{print $1}')
python3 "$SK/take_screenshot.py" --mode temp --window-id "$WID"
```

> **Do NOT run `cursor --reuse-window …` yourself to "open a file"** — a manual
> folder-uri reload blanks the box-attached window (empties the editor and
> forces a fresh dev-container reconnect). Just let `agentbox code` open it and
> wait; capture the window as-is. The user has many Cursor windows open, so
> always resolve the `--window-id` by the `[Container agentbox-…]` title, never
> `--app "Cursor"` alone (that grabs an arbitrary one).

**`push-approval.png`** → sync-and-git (the figure in the **Pull requests**
section). The host relay gates outbound `git push` / `gh pr create` that the
**in-box agent** initiates; the approval surfaces as a Y/N band in the attached
session footer. **Let the agent drive it** — that's what reliably triggers the
band (a bare `docker exec … agentbox-ctl git push` does not: the relay pushes
the host main-repo HEAD, and the box's own `agentbox/<name>` branch is
auto-allowed anyway).

```bash
# A box on a real git repo with a remote (NOT express-ready — its /workspace is
# tar-seeded, not a git repo). Use ../agentbox-test-repo-gh (https origin + gh).
PROJ=/Users/marco/Projects/AgentBox/agentbox-test-repo-gh
WID=$(osascript \
  -e 'tell application "iTerm" to activate' \
  -e 'tell application "iTerm" to set b to (create window with default profile)' \
  -e 'tell application "iTerm" to set bounds of b to {60, 90, 1200, 660}' \
  -e "tell application \"iTerm\" to tell current session of b to write text \"cd $PROJ && AGENTBOX_CARRY=skip agentbox claude -n pr --attach-in same\"" \
  -e 'tell application "iTerm" to id of b')
# once attached, send the agent the task:
docker exec agentbox-pr bash -lc "tmux send-keys -t claude 'Make the home page better and then push to a new branch and create a PR' Enter; sleep 1; tmux send-keys -t claude Enter"
```

The agent improves the page, commits, pushes, then runs `gh pr create` — and the
host blocks on a **`[↑] GH PR CREATE — Allow gh pr create from box pr?`** band
(`Y Yes · N No`). Poll for it, then capture by `--window-id`:

```bash
# poll the box's claude pane until the push/PR command is blocking (no exit code),
# then screenshot the host window while the band is up:
SK=~/.agents/skills/screenshot/scripts
python3 "$SK/take_screenshot.py" --mode temp --window-id "$WID"
# crop to ~1120px tall (drop the blue agentbox status line + gray iTerm bar so
# the yellow approval band is the bottom of the frame), then answer in the
# session: `y` to approve (completes the PR) or `n` to deny.
```

> **Gotchas:** the band renders *fine* over the full Claude TUI (it sits above
> the status line — earlier doubt was just because no prompt was live). The
> agent's first push to a literal non-agentbox branch (`git push origin <b> -u`)
> errored on `refs/remotes/origin/HEAD`; it then fell back to a plain
> `agentbox-ctl git push` (its `agentbox/pr` branch → auto-allowed, no prompt) —
> so the **PR-create** is what actually surfaced the gate. That's on-message for
> the Pull-requests figure, so we kept it.
>
> **Side effects are expected and fine:** approving (`y`) really pushes the
> branch and opens the PR on `agentbox-test-repo` — that's a dedicated throwaway
> test repo, so leaving the pushed `agentbox/pr` branch + the open PR behind is
> harmless. Close/delete them later if you want, or answer `n` to deny and
> capture the band without the side effects.

### Phase D — Diagrams (illustrations, not screenshots)

On-brand (paper `#f6f6f3`, ink `#16181c`, accent `#128a4f`, IBM Plex). Save under
`public/diagrams/` and add `src=` to the figure.

**Recipe that worked for core-concepts (AI-generated, reusable for the rest):**
the **nano-banana-pro** skill (Google Gemini 3 Pro Image) renders crisp,
correctly-spelled labels — good enough for these card-and-arrow diagrams. **Pass
the home-page diagram as `--input-image`** so the output inherits its exact
style (outlined pills, dashed sub-cards, line-icon set, green palette, stacked
right-panel shadow). The reference is committed at
**`apps/web/diagram-refs/home-diagram.png`** (a capture of the interactive
diagram in `public/home.html`). The trick that stops it over-copying the source
labels: tell it explicitly *"use the image ONLY as a visual STYLE template, do
NOT keep any of its text/labels, remove its top action chips"*, then list the
new content.

Then **read the PNG back to QA the text** (the skill says don't, but label QA
matters here), regenerate up to ~4× tweaking the prompt, and downscale/quantize
before committing (2K output is several MB; resize to ~1600px wide +
`Image.quantize(256, dither=NONE)` → ~0.5-1MB, no visible quality loss).

- **core-concepts** — DONE (`/diagrams/core-concepts.png`). Host panel
  (workspace, ~/.claude, git creds "never leave the host", host relay "you
  approve") ── teleport→ / ←git push/PR 🔒 "you approve on host" ── Box panel
  (**agent has sudo** — not root, /workspace, no keys/no host net), faint stacked
  outlines behind Box for "one per agent run". The diagram + the page text both
  state **git push / PR needs your explicit approval on the host**. **Exact
  command + verbatim prompt used** (run from `apps/web/`):

  ```bash
  uv run ~/.claude/skills/nano-banana-pro/scripts/generate_image.py \
    --input-image diagram-refs/home-diagram.png \
    --resolution 2K --filename /tmp/core-concepts.png \
    --prompt "$(cat <<'PROMPT'
  Use the provided image ONLY as a visual STYLE template — copy its exact aesthetic: warm light paper background, forest-green (#1f7a4d) thin line icons / labels / arrows, dark slate headings, muted grey secondary text, monospace IBM-Plex-style type, thin 1.5px soft-grey rounded-card borders, small outlined rounded pills, dashed-border sub-cards, the faint stacked duplicate-panel outlines behind the right panel, and the thin dashed arrow style. Do NOT keep any of the reference's text or labels, and remove its top row of action chips. Redraw it as a NEW two-panel diagram with the following content.

  LEFT panel titled 'Host' with a small monitor line-icon and an outlined rounded pill reading 'your machine'. Four stacked sub-cards, each a thin line icon plus two short text lines:
  - folder icon, line 1: 'workspace', line 2: 'your project files'
  - key icon, line 1: '~/.claude', line 2: 'credentials & sessions'
  - padlock icon, line 1: 'git credentials & SSH keys', line 2: 'never leave the host'
  - hub icon, line 1: 'host relay', line 2: 'git push & PRs run here, you approve'

  RIGHT panel titled 'Box' with a small cube line-icon and an outlined rounded pill reading 'isolated'. Behind this panel draw two faint duplicate rounded-rectangle outlines, offset down and to the right, to suggest 'one box per agent run'. Three stacked sub-cards inside the front panel:
  - terminal icon, line 1: 'agent has sudo', line 2: 'full toolchain, no host access'
  - folder icon (dashed border), line 1: '/workspace', line 2: 'git worktree'
  - shield icon, line 1: 'no keys, no host network'

  BETWEEN the two panels, two short horizontal dashed arrows stacked vertically in the gap:
  - TOP arrow pointing RIGHT (Host to Box), labeled 'teleport'
  - BOTTOM arrow pointing LEFT (Box to Host), labeled 'git push / PR' with a small padlock icon, and directly beneath it smaller muted text reading 'you approve on host'

  All text crisp, sharp and correctly spelled. Balanced landscape 16:9 composition, generous whitespace.
  PROMPT
  )"
  ```
The four below are all **DONE**. Each was generated with the **same command** as
core-concepts — `--input-image diagram-refs/home-diagram.png --resolution 2K`,
run from `apps/web/` — only the `--prompt` and `--filename` differ. Then
resized to 1600px wide + `Image.quantize(256, dither=NONE)` before committing.
Verbatim prompts:

- **configuration** — DONE (`/diagrams/configuration.png`). A vertical precedence
  ladder, highest layer on top.

  ```text
  Use the provided image ONLY as a visual STYLE template — copy its exact aesthetic: warm light paper background, forest-green (#1f7a4d) thin line icons / labels / arrows, dark slate headings, muted grey secondary text, monospace IBM-Plex-style type, thin 1.5px soft-grey rounded-card borders, small outlined rounded pills. Do NOT keep any of the reference's text, labels, or its two-panel layout; remove its top row of action chips. Redraw as a NEW diagram with this content and layout.

  A vertical PRECEDENCE LADDER: five horizontal rounded cards stacked vertically with small gaps, highest precedence at the TOP, lowest at the BOTTOM. Each card has a thin line icon on the left, a bold dark heading, and a smaller grey second line:
  1 (top): flag icon, heading 'CLI flag', subtext 'the command you type, this run only'
  2: document icon, heading 'workspace', subtext 'defaults: in agentbox.yaml, committed'
  3: folder icon, heading 'per-project', subtext '~/.agentbox/projects/<hash>/config.yaml'
  4: gear icon, heading 'global', subtext '~/.agentbox/config.yaml, this machine'
  5 (bottom): cube icon, heading 'built-in', subtext 'BUILT_IN_DEFAULTS, the fallback'

  Along the LEFT edge of the ladder, one long thin green arrow pointing DOWNWARD spanning all five cards, with a small rotated label 'first layer that sets a key wins, unset keys fall through'. A small outlined green pill at the top right reading 'highest wins'. Balanced composition, 4:3, generous whitespace. All text crisp, sharp and correctly spelled.
  ```

- **services-and-tasks** — DONE (`/diagrams/services-and-tasks.png`). Left-to-right
  `needs` DAG, task vs service pills.

  ```text
  Use the provided image ONLY as a visual STYLE template — copy its exact aesthetic: warm light paper background, forest-green (#1f7a4d) thin line icons / labels / arrows, dark slate headings, muted grey secondary text, monospace IBM-Plex-style type, thin 1.5px soft-grey rounded-card borders, small outlined rounded pills. Do NOT keep any of the reference's text, labels, or its two-panel layout; remove its top row of action chips. Redraw as a NEW diagram with this content and layout.

  A small left-to-right DEPENDENCY GRAPH (DAG) of four rounded node-cards connected by thin green arrows that point in the direction of dependency. Each node-card has a small icon, a bold name, and a tiny grey command line. Two of them carry a small outlined pill 'task' and two carry a small outlined pill 'service':
  - 'install' (pill 'task', gear icon, 'pnpm install') on the far left, upper row
  - 'migrate' (pill 'task', database-arrow icon, 'pnpm db:migrate') to its right, upper row
  - 'db' (pill 'service', database icon, 'postgres, ready when :5432') on the far left, LOWER row, with NO incoming arrow (it starts in parallel)
  - 'web' (pill 'service', globe icon, 'pnpm dev') on the far right, centered vertically
  Arrows: install -> migrate (upper row), then migrate -> web AND db -> web (two arrows converging into 'web', showing web waits on both). A small outlined pill caption 'needs: forms a DAG'. Landscape 16:9, generous whitespace. All text crisp, sharp and correctly spelled.
  ```

- **sync-and-git** — DONE (`/diagrams/sync-and-git.png`). **Single cloud-scenario**
  diagram with two arrows (an earlier "commits land in the *host* shared `.git`"
  version was wrong — that's Docker-only; and a two-panel Docker-vs-cloud version
  was dropped as too busy). A `Box` panel (cloud pill `daytona / hetzner / vercel`)
  holds `/workspace` (worktree) and `box .git` (seeded from a git bundle) with a
  SOLID `git commit — instant, local to the box` arrow between them; a DASHED
  `git push — via the relay, you approve` arrow exits through a `host relay`🔒
  card to `remote`.

  ```text
  Use the provided image ONLY as a visual STYLE template — copy its exact aesthetic: warm light paper background, forest-green (#1f7a4d) thin line icons / labels / arrows, dark slate headings, muted grey secondary text, monospace IBM-Plex-style type, thin 1.5px soft-grey rounded-card borders, small outlined rounded pills, dashed-border sub-cards and thin dashed arrows where noted. Do NOT keep any of the reference's text or labels; remove its top row of action chips. Redraw as a NEW single diagram of the cloud-box git flow, with TWO arrows — a local commit and a push.

  A rounded panel on the LEFT titled 'Box' with a small cloud line-icon and an outlined rounded pill reading 'daytona / hetzner / vercel'. Inside the panel, two stacked sub-cards: a folder icon labeled '/workspace' with grey subtext 'git worktree', and below it a cylinder/database icon labeled 'box .git' with grey subtext 'seeded from a git bundle'. Between these two inner cards, a SHORT SOLID green arrow pointing down from '/workspace' to 'box .git', with a small green label beside it 'git commit — instant, local to the box'.

  From the right edge of the Box panel, a THIN DASHED green arrow points RIGHT, passing through a small rounded card labeled 'host relay' (hub icon with a tiny padlock), and continues to a cloud icon labeled 'remote'. Label this dashed path 'git push — via the relay, you approve'.

  Landscape 16:9, balanced, generous whitespace. All text crisp, sharp and correctly spelled.
  ```

- **teleport-a-project** — DONE (`/diagrams/teleport-a-project.png`). Host repo
  (untouched) ──teleport→ Box `/workspace` worktree on `agentbox/<name>`.

  ```text
  Use the provided image ONLY as a visual STYLE template — copy its exact aesthetic: warm light paper background, forest-green (#1f7a4d) thin line icons / labels / arrows, dark slate headings, muted grey secondary text, monospace IBM-Plex-style type, thin 1.5px soft-grey rounded-card borders, small outlined rounded pills, dashed-border sub-cards, and a thin dashed arrow. Do NOT keep any of the reference's text or labels; remove its top row of action chips. Redraw as a NEW two-panel diagram with this content.

  LEFT panel titled 'Host repo' with a small monitor line-icon and an outlined rounded pill reading 'untouched'. Two stacked sub-cards:
  - branch icon, line 1: 'your branch', line 2: 'working tree never modified'
  - cylinder/database icon, line 1: '.git', line 2: 'shared with the box'
  Below the cards, small grey note: 'uncommitted work = git stash + untracked files'.

  BETWEEN the panels, one thick horizontal dashed arrow pointing RIGHT (Host to Box) labeled 'teleport', with a smaller muted sub-label 'stash + untracked copied in'.

  RIGHT panel titled 'Box' with a small cube line-icon and an outlined rounded pill reading 'isolated'. Two stacked sub-cards:
  - folder icon, line 1: '/workspace', line 2: 'writable git worktree'
  - a branch-tag shaped pill reading 'branch: agentbox/<name>'
  Below the cards, small grey note: 'commits land here, on this branch only'.

  Landscape 16:9, generous whitespace. All text crisp, sharp and correctly spelled.
  ```

### Phase E — External / manual (you)

- **`hetzner-token.png`** → hetzner. Log into the Hetzner Cloud console →
  Security → API Tokens → the "Read & Write" token creation page. Screenshot and
  crop to the panel.

---

## Wiring an image in

Once a PNG is in `apps/web/public/screenshots/`, add `src` to its figure (keep the
caption):

```mdx
<Figure src="/screenshots/<name>.png" caption="…" />
```

`agentbox build` (or `pnpm --filter @agentbox/web build`) should stay green and the
image serves at `/screenshots/<name>.png`.
