/* Every AgentBox screen under shots/, and how it was taken.
   `pnpm screens` turns this file into the gallery (screens/index.html) and
   checks it against the files; `pnpm screens retake [id or prefix]` runs the
   `shoot` commands again. See README.md.

   One entry per screen. A screen with several pictures (a menu, then the same
   menu with a submenu open) is one entry with several `files`, in order.

     id        "<surface>/<name>", used in links: index.html#<id>
     title     what the screen is called in the gallery
     topic     one of TOPICS: the gallery's sections
     what      one line on what it shows
     files     the pictures, under shots/ (or `docs:` + a path under
               apps/web/public/screenshots/), each with its `state` and the
               `shoot` command that takes it again
     cover     which of `files` the gallery shows first (default 0)
     social    defaults for `pnpm export`: { title, crop: [x, y, w, h] in image pixels, kind }

   Where it is in the product:
     from      the id of the screen you come from (none: a place you start at)
     via       what you click or do there to get here

   How it was taken:
     setup     the environment, from setups.mjs
     url       the page or command
     edits     everything that differs from what the product shows on its own
     notes     what is uncertain, and what will differ on a new run
     check     a warning shown in red: read it before posting the picture

   All data is the made-up Acme company in fixtures/acme.mjs (and, for the
   tray, the same story in the tray's own fixture mode). */

/* A hub page: the fixture hub, 1440x900 @2x, light theme. */
const hub = ({ files, ...entry }) => ({
  topic: "Web hub",
  setup: "fixture-hub",
  url: files[0].shoot.split(" ")[3],
  ...entry,
  files: files.map((f) => ({ ...f, file: f.shoot.split(" ")[2], shoot: f.shoot })),
});

/* A tray screen: AgentBoxE2E.app --fixtures, captured window by window. */
const tray = ({ files, ...entry }) => ({
  topic: "macOS tray",
  setup: "fixture-tray",
  ...entry,
  social: { kind: "cutout", ...entry.social },
  files: files.map((f) => ({ ...f, file: f.shoot.split(" ")[2] })),
});

/* A CLI screen: the real CLI in a PTY, drawn into a terminal window. */
const cli = ({ files, ...entry }) => ({
  topic: "CLI",
  setup: "fixture-cli",
  url: "agentbox " + files[0].shoot.split(" -- ")[1],
  ...entry,
  social: { kind: "cutout", ...entry.social },
  files: files.map((f) => ({ ...f, file: f.shoot.split(" ")[2] })),
});

export const TOPICS = ["Web hub", "Web hub: skills and accounts", "Public site", "macOS tray", "CLI", "From the docs"];

export const SCREENS = [
  /* ======== Web hub ======== */

  hub({
    id: "hub/dashboard",
    title: "Hub dashboard: the overview",
    what: "The overview a hub opens on: KPIs for today, \"Your day\" lanes of the last 12 hours, Live now, Recent activity, Shipped this week, Needs a hand, and every box in a table with facets. Light and dark.",
    files: [
      { state: "light", shoot: "pnpm shoot hub/dashboard.png / --full" },
      { state: "dark", shoot: "pnpm shoot hub/dashboard-dark.png / --full --dark" },
    ],
    notes: ["The KPIs, lanes and Shipped this week come from GET /api/v1/usage/stats and /api/v1/activity, generated in fixtures/activity.mjs: six weeks of Acme sprints run through the real buildUsageStats."],
    social: { title: "Every coding agent in its own box", crop: [0, 0, 2880, 1800] },
  }),
  hub({
    id: "hub/boxes",
    title: "Your boxes, by project",
    what: "The dashboard's box table grouped by project: running, paused, creating, failed and stopped boxes on docker, vercel, hetzner and e2b, with tokens and context use.",
    from: "hub/dashboard",
    via: "By project, above the box table",
    files: [{ shoot: "pnpm shoot hub/boxes.png / --click 'text=By project' --scroll-to 'h2:text-is(\"Your boxes\")'" }],
  }),
  hub({
    id: "hub/sidebar-collapsed",
    title: "The collapsed sidebar rail",
    what: "The dashboard with the sidebar folded to its icon rail.",
    from: "hub/dashboard",
    via: "The sidebar button left of the breadcrumbs (remembered per browser)",
    files: [{ shoot: "pnpm shoot hub/sidebar-collapsed.png / --storage hub-sidebar=collapsed" }],
    edits: ["The collapsed state is set in localStorage (hub-sidebar=collapsed) before the page loads, as the toggle would."],
  }),
  hub({
    id: "hub/box-detail",
    title: "Box detail",
    url: "/boxes/<box id>",
    what: "One box: status, git, services, the skills it holds, access links and its approvals.",
    from: "hub/dashboard",
    via: "Click a box row",
    files: [{ shoot: "pnpm shoot hub/box-detail.png /boxes/7f3a9c21b8d4 --full" }],
    social: { crop: [0, 0, 2880, 1800] },
  }),
  hub({
    id: "hub/account-switch",
    topic: "Web hub: skills and accounts",
    title: "Switching a box to another account",
    url: "/boxes/<box id>",
    what: "The box page's account row: a selector of the agent's accounts (each with its kind, and a note at its limit) and the box's recent switches. A switch writes the new login into the box's own credential file and the agent keeps running.",
    from: "hub/dashboard",
    via: "Click a box row, then the Details card at the bottom",
    files: [{ shoot: "pnpm shoot hub/account-switch.png /boxes/a3c9e61d20f4 --full" }],
    social: { title: "Move a box to another subscription; the conversation carries on" },
  }),
  hub({
    id: "hub/project",
    title: "Project page",
    url: "/projects/<project id>",
    what: "A project's boxes, its seed in custody and its service bot with backups.",
    from: "hub/dashboard",
    via: "Click a project in the sidebar",
    files: [{ shoot: "pnpm shoot hub/project-detail.png /projects/fx-payments-worker --full" }],
    social: { crop: [0, 0, 2880, 1800] },
  }),
  hub({
    id: "hub/create-box",
    title: "Create a box",
    url: "/projects/<project id>, then Create box",
    what: "The create modal over a project page: provider, agent, account and first prompt.",
    from: "hub/project",
    via: "Create box",
    files: [{ shoot: "pnpm shoot hub/create-box.png /projects/fx-payments-worker --click text=Create\\ box" }],
    notes: ["The modal opens over the project page; the click is the first \"Create box\" button on the page."],
  }),
  hub({
    id: "hub/approvals",
    title: "Approvals",
    what: "Host actions boxes asked for, waiting on a yes: a shell command on the host and a git push.",
    from: "hub/dashboard",
    via: "Approvals in the sidebar, or View all on the banner",
    files: [{ shoot: "pnpm shoot hub/approvals.png /approvals" }],
  }),
  hub({
    id: "hub/usage",
    title: "Usage: work, side by side",
    what: "The Work view of the last 30 days: the hero sentence, KPIs, the busiest day's Gantt, boxes at once, tokens per day, the 30-day activity grid, providers, lines changed, Recently merged and the leaderboard.",
    files: [{ shoot: "pnpm shoot hub/usage.png /usage --full" }],
    notes: ["Generated by fixtures/activity.mjs through the real buildUsageStats; the session lanes named session:… are the host sessions, as the hub names them."],
    social: { title: "What your agents did side by side, and what they shipped", crop: [0, 0, 2880, 1800] },
  }),
  hub({
    id: "hub/usage-ai",
    title: "Usage: AI usage",
    what: "The AI usage view: tokens by day, agent, subscription, box and model, with the Subscription filter.",
    from: "hub/usage",
    via: "AI usage, in the page header",
    files: [{ shoot: "pnpm shoot hub/usage-ai.png /usage --click 'text=AI usage' --full" }],
    social: { title: "Where the tokens went, per box and per account", crop: [0, 0, 2880, 1800] },
  }),
  hub({
    id: "hub/usage-activity",
    title: "Usage: the 30-day activity grid and Recently merged",
    what: "Two cards of the Usage page on their own: a square per day of the last 30, darker for more work, and the last pull requests the agents landed, with titles and line counts.",
    from: "hub/usage",
    files: [
      { state: "activity grid", shoot: "pnpm shoot hub/usage-activity.png /usage --el .wall-card" },
      { state: "Recently merged", shoot: "pnpm shoot hub/usage-merged.png /usage --size 1800x900 --el '.card:has(h2:text-is(\"Recently merged\"))'" },
    ],
    social: { title: "Six weeks of sprints, one square a day" },
  }),
  hub({
    id: "hub/share-dialog",
    title: "Share the Usage page",
    what: "The Share dialog: the link it will make, a Page preview of exactly what is published (numbers only, no repo, box or session names), the name to show, and the shares made before. JSON shows the body that is posted.",
    from: "hub/usage",
    via: "Share, in the page header",
    files: [
      { state: "Page preview", shoot: "pnpm shoot hub/share-dialog.png /usage --size 1440x1100 --click 'button:text-is(\"Share\")' --wait 500" },
      { state: "JSON preview", shoot: "pnpm shoot hub/share-json.png /usage --size 1440x1100 --click 'button:text-is(\"Share\")' --click 'text=JSON' --wait 500" },
    ],
    edits: ["The fixture hub answers POST /api/v1/usage/share itself: the preview comes from the real toShare(), and nothing is ever posted to agent-box.sh."],
    social: { title: "Share what your agents shipped, without the code" },
  }),
  hub({
    id: "hub/files",
    title: "Files: what the hub holds for boxes",
    what: "Project files per project, agent logins per account, the skills library, bakes and box keys, with size and last update; metadata only.",
    files: [{ shoot: "pnpm shoot hub/files.png /settings/files --full" }],
  }),
  hub({
    id: "hub/devices",
    title: "Devices: the PCs enrolled on this hub",
    what: "Three enrolled machines, a revoked one, and an enrollment code waiting for approval.",
    files: [{ shoot: "pnpm shoot hub/devices.png /settings/devices --full" }],
  }),
  hub({
    id: "hub/settings",
    title: "Settings: General (providers)",
    what: "Docker, Hetzner and Vercel ready; E2B, Daytona and DigitalOcean not set up. Below them, what the hub does when a box's subscription hits its limit: ask, or switch on its own.",
    files: [{ shoot: "pnpm shoot hub/settings.png /settings --full" }],
  }),
  hub({
    id: "hub/system",
    title: "System: hub version, bakes and the box image",
    what: "The hub's own state: version, deploy record, which provider bases are baked, the docker image.",
    files: [{ shoot: "pnpm shoot hub/system.png /settings/system --full" }],
  }),

  /* ======== Web hub: skills and accounts ======== */

  hub({
    id: "hub/skills",
    topic: "Web hub: skills and accounts",
    title: "Skills library",
    what: "The hub-owned skills library next to this machine's skills: git, marketplace, linked-folder and uploaded skills, every sync state (same, only on Hub, only on the PC, differs), two updates waiting for approval, and sql-style skipped.",
    files: [{ shoot: "pnpm shoot hub/skills.png /settings/skills --full" }],
    social: { title: "One skills library for every box" },
  }),
  hub({
    id: "hub/skills-update",
    topic: "Web hub: skills and accounts",
    title: "Review a skill update",
    what: "The update dialog of a library skill: the file diff between the current and the pending version, and the secret scan.",
    from: "hub/skills",
    via: "Review update on a skill with an update waiting",
    files: [{ shoot: "pnpm shoot hub/skills-update.png /settings/skills --size 1440x1500 --click text=Review\\ update" }],
    notes: ["Taken 1500px tall: at 900 the dialog squeezes each file panel."],
  }),
  hub({
    id: "hub/subscriptions",
    topic: "Web hub: skills and accounts",
    title: "Subscriptions: plans and keys",
    what: "Logins and setup tokens grouped by Anthropic and OpenAI Codex, plus API keys: each card with its Name, tier, the Default badge, boxes, one meter per limit window the plan reports, and an amber note at the limit.",
    files: [{ shoot: "pnpm shoot hub/subscriptions.png /settings/subscriptions --full" }],
    social: { title: "Several Claude and Codex accounts, with their plan limits", crop: [0, 0, 2880, 1800] },
  }),
  hub({
    id: "hub/quota-meter",
    topic: "Web hub: skills and accounts",
    title: "Quota meter in the top bar",
    what: "The two subscriptions in use closest to a limit, one bar per window; the card lists every in-use subscription's windows and resets.",
    via: "Hover or click the meter at the right of the top bar.",
    files: [{ shoot: "pnpm shoot hub/quota-meter.png / --click button[aria-haspopup=dialog] --wait 300" }],
    social: { title: "Every plan limit, one glance from any page" },
  }),

  /* ======== Public site ======== */

  {
    id: "web/share-page",
    topic: "Public site",
    title: "A shared Usage page on agent-box.sh",
    what: "What a Share publishes: the Usage page's numbers under the name typed, with no repository, box or session names.",
    from: "hub/share-dialog",
    via: "Share, then open the link",
    setup: "web-dev",
    url: "/s/example",
    files: [{ file: "web/share-page.png", shoot: "pnpm shoot web/share-page.png /s/example --base http://127.0.0.1:3140 --full --hide nextjs-portal" }],
    notes: ["/s/example draws the usage-view design fixture (November, 26 days in), not the Acme numbers of the hub screens."],
    social: { kind: "page", title: "Share what your agents shipped", crop: [0, 0, 2880, 1800] },
  },

  /* ======== macOS tray ======== */

  tray({
    id: "tray/menu",
    title: "Tray menu",
    what: "Approval cards with Approve/Deny, then boxes grouped under their manager session and project, with tickets, PRs and limit states.",
    files: [{ shoot: "pnpm shoot:tray tray/menu.png --restart" }],
    social: { title: "Every box, one click from the menu bar" },
  }),
  tray({
    id: "tray/skill-updates",
    title: "Tray: Subscriptions band and skill updates",
    what: "The bottom of the menu: the Subscriptions band (each account with its limit meters, the default per agent, revoked and expiring logins), then the Environment row with \"3 not in sync\" and its submenu of skill updates waiting for approval.",
    from: "tray/menu",
    via: "The Environment row at the bottom",
    files: [{ shoot: "pnpm shoot:tray tray/skill-updates.png --press agentbox.environment" }],
  }),
  tray({
    id: "tray/skill-approve",
    title: "Tray: approve a skill update",
    what: "The confirmation before a version becomes current: running boxes sync it now, stopped ones on their next start.",
    from: "tray/skill-updates",
    via: "A row under Environment › Waiting for approval (skill → version)",
    files: [{ shoot: "pnpm shoot:tray tray/skill-approve-confirm.png --restart --press agentbox.environment --press agentbox.skillUpdates.review-pr --alert" }],
    notes: ["--alert quits the fixture app after the shot: the alert is modal, and a relaunch resets the demo."],
  }),
  tray({
    id: "tray/box-skills-behind",
    title: "Tray: a box that is behind on skills",
    what: "A box's submenu: its live state and tokens, the Subscription it runs on (switchable), Git, and a \"Skills behind: …\" line naming the skills it lacks, with Sync Skills.",
    from: "tray/menu",
    via: "Hover a box row",
    files: [{ shoot: "pnpm shoot:tray tray/box-skills-behind.png --press agentbox.box.queue-retries" }],
  }),
  tray({
    id: "tray/subscriptions",
    title: "Tray: Settings › Subscriptions",
    what: "Every login, setup token and API key per agent, with plan meters, the Default badge and Make default, revoked and expiring states, and what to do when a box hits its limit (pause and ask, or switch to the next available).",
    from: "tray/menu",
    via: "Manage… on the Subscriptions band",
    files: [{ shoot: "pnpm shoot:tray tray/subscriptions.png --restart --press agentbox.subscriptions.manage" }],
  }),
  tray({
    id: "tray/settings-skills",
    title: "Tray: Settings › Skills",
    what: "This Mac's skills next to the Hub library: updates waiting for approval, a drift summary with Sync Global, and per skill its sync state (only on this Mac, on both, Mac or Hub newer, skipped) with Upload, Update, Skip and Sync again.",
    from: "tray/skill-updates",
    via: "Open Skills Settings… under the Environment row",
    files: [{ shoot: "pnpm shoot:tray tray/settings-skills.png --restart --press agentbox.environment --press agentbox.skillUpdates.openSettings" }],
  }),
  tray({
    id: "tray/manager",
    title: "Manager window",
    what: "Tasks grouped by box with progress, the latest activity (a PR ready to merge with Approve), and the manager session pane.",
    from: "tray/menu",
    via: "Open Manager (⌘M)",
    files: [{ shoot: "pnpm shoot:tray tray/manager.png --manager fx-commerce" }],
    social: { kind: "cutout", title: "Plan the work, watch every box, approve the merge" },
  }),

  /* ======== CLI ======== */

  cli({
    id: "cli/install",
    title: "Setup wizard",
    what: "`agentbox install` (and the first command on a new machine): the system check, then the provider choice.",
    files: [
      { state: "pick a provider", shoot: "pnpm shoot:cli cli/install-provider.png --first-run --cols 122 --rows 22 --wait-for Which -- install" },
      { state: "Hetzner API token", shoot: "pnpm shoot:cli cli/install-hetzner.png --first-run --cols 110 --rows 34 --wait-for Which --send '<Down><Down>' --send '<Enter>' --settle 2500 -- install" },
    ],
    notes: ["The \"system warn: optional sshfs, macfuse\" line is this Mac's real check result."],
    social: { title: "Set up in one command" },
  }),
  cli({
    id: "cli/ls",
    title: "agentbox ls",
    what: "Every box on the hub: state, agent activity (and its account), provider, URL and project.",
    files: [{ shoot: "pnpm shoot:cli cli/ls.png --cols 150 --rows 20 -- ls --global" }],
  }),
  cli({
    id: "cli/credentials",
    title: "agentbox credentials",
    what: "The subscriptions table TUI: each account's Name, kind, identity, status (ok, expiring, at limit), plan limits, whether it is the default for new boxes, and the boxes on it.",
    files: [{ shoot: "pnpm shoot:cli cli/credentials.png --cols 172 --rows 22 --settle 2500 -- credentials" }],
    notes: ["The BOXES column runs to the terminal's edge: the TUI does not wrap it."],
    social: { title: "Every Claude and Codex login, one table" },
  }),
  cli({
    id: "cli/skills",
    title: "agentbox skills",
    what: "The skills table TUI: this PC's skills next to the hub's library (differs, hub only, local only, an update pending, sql-style skipped), and the upload, download, choose and discard actions.",
    files: [{ shoot: "pnpm shoot:cli cli/skills.png --cols 140 --rows 26 --settle 3000 -- skills" }],
    edits: ["shoot-cli writes Acme's PC skills (fixtures/acme.mjs, the studio-mac comparison) into the scratch HOME first. They are short stand-ins, so the TUI counts each as differing from the hub's copy and none as the same."],
  }),
  cli({
    id: "cli/help",
    title: "agentbox --help",
    what: "The command list.",
    files: [{ shoot: "pnpm shoot:cli cli/help.png --cols 100 --rows 60 -- --help" }],
  }),

  /* ======== From the docs ======== */

  {
    id: "docs/dashboard",
    topic: "From the docs",
    title: "agentbox dashboard (docs capture)",
    what: "The terminal dashboard: the box list on the left, the selected box's live agent session on the right.",
    setup: "docs-site",
    files: [{ file: "docs:dashboard.png" }],
    notes: ["Needs live tmux sessions in real boxes, which the fixtures cannot provide, so it comes from the docs. Real boxes from the docs test environment (2026-06-02)."],
    social: { kind: "page" },
  },
  {
    id: "docs/claude-tui",
    topic: "From the docs",
    title: "Claude Code in a box (docs capture)",
    what: "An attached Claude Code session running inside a docker box.",
    setup: "docs-site",
    files: [{ file: "docs:claude-tui.png" }],
  },
  {
    id: "docs/push-approval",
    topic: "From the docs",
    title: "Push approval in the terminal (docs capture)",
    what: "The approval band a box raises when its agent runs gh pr create.",
    setup: "docs-site",
    files: [{ file: "docs:push-approval.png" }],
  },
  {
    id: "docs/novnc-desktop",
    topic: "From the docs",
    title: "A box's desktop over noVNC (docs capture)",
    what: "The in-box browser and desktop.",
    setup: "docs-site",
    files: [{ file: "docs:novnc-desktop.png" }],
    check: "apps/web/images.md marks this one stale: it predates the window manager and the dock.",
  },
  {
    id: "docs/herdr",
    topic: "From the docs",
    title: "Herdr: a box blocked on an approval (docs capture)",
    what: "Claude in a box inside Herdr, waiting on a gh pr create approval, with the agents sidebar.",
    setup: "docs-site",
    files: [{ file: "docs:herdr-permission-prompt.png" }],
  },
  {
    id: "docs/cmux",
    topic: "From the docs",
    title: "cmux: box status in the sidebar (docs capture)",
    what: "Box state as colour and description in the cmux sidebar.",
    setup: "docs-site",
    files: [{ file: "docs:cmux-sidebar-state.png" }],
  },
];
