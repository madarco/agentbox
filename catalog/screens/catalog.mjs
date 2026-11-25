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

export const TOPICS = ["Web hub", "Web hub: skills and accounts", "macOS tray", "CLI", "From the docs"];

export const SCREENS = [
  /* ======== Web hub ======== */

  hub({
    id: "hub/boxes",
    title: "Hub dashboard: every box, grouped by project",
    what: "The boxes list with a pending approval banner on top: running, paused, creating, failed and stopped boxes on docker, vercel, hetzner and e2b.",
    files: [{ shoot: "pnpm shoot hub/boxes.png / --full" }],
    social: { title: "Every coding agent in its own box", crop: [0, 0, 2880, 1800] },
  }),
  hub({
    id: "hub/box-detail",
    title: "Box detail",
    url: "/boxes/<box id>",
    what: "One box: status, git, services, the skills it holds, access links and its approvals.",
    from: "hub/boxes",
    via: "Click a box row",
    files: [{ shoot: "pnpm shoot hub/box-detail.png /boxes/7f3a9c21b8d4 --full" }],
    social: { crop: [0, 0, 2880, 1800] },
  }),
  hub({
    id: "hub/project",
    title: "Project page",
    url: "/projects/<project id>",
    what: "A project's boxes, its seed in custody and its service bot with backups.",
    from: "hub/boxes",
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
    from: "hub/boxes",
    via: "Approvals in the sidebar, or View all on the banner",
    files: [{ shoot: "pnpm shoot hub/approvals.png /approvals" }],
  }),
  hub({
    id: "hub/usage",
    title: "Usage: tokens by day, agent, account, box and model",
    what: "Seven days of token usage (demo numbers) by day, agent, account, box and model.",
    files: [{ shoot: "pnpm shoot hub/usage.png /usage --full" }],
    social: { title: "Where the tokens went, per box and per account", crop: [0, 0, 2880, 1800] },
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
    what: "Docker, Hetzner and Vercel ready; E2B, Daytona and DigitalOcean not set up.",
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
    what: "The hub-owned skills library: git, marketplace, linked-folder and uploaded skills, two updates waiting for approval.",
    files: [{ shoot: "pnpm shoot hub/skills.png /settings/skills" }],
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
    title: "Subscriptions: LLM accounts",
    what: "Several logins, setup tokens and API keys per agent, with the boxes that use each one.",
    files: [{ shoot: "pnpm shoot hub/subscriptions.png /settings/subscriptions" }],
    social: { title: "Several Claude and Codex accounts, one per box" },
  }),

  /* ======== macOS tray ======== */

  tray({
    id: "tray/menu",
    title: "Tray menu",
    what: "Boxes grouped under their manager session and project, an approval with Approve/Deny, and the footer.",
    files: [{ shoot: "pnpm shoot:tray tray/menu.png --restart" }],
    social: { title: "Every box, one click from the menu bar" },
  }),
  tray({
    id: "tray/skill-updates",
    title: "Tray: Skill updates submenu",
    what: "\"Skill updates (2)\": one row per waiting update (name → version), then Review in hub….",
    from: "tray/menu",
    via: "Skill updates (2)",
    files: [{ shoot: "pnpm shoot:tray tray/skill-updates.png --press agentbox.footer.skillUpdates" }],
  }),
  tray({
    id: "tray/skill-approve",
    title: "Tray: approve a skill update",
    what: "The confirmation before a version becomes current: running boxes sync it now, stopped ones on their next start.",
    from: "tray/skill-updates",
    via: "A row under Skill updates (skill → version)",
    files: [{ shoot: "pnpm shoot:tray tray/skill-approve-confirm.png --press agentbox.footer.skillUpdates --press agentbox.skillUpdates.review-pr --alert" }],
    notes: ["--alert quits the fixture app after the shot: the alert is modal, and a relaunch resets the demo."],
  }),
  tray({
    id: "tray/box-skills-behind",
    title: "Tray: a box that is behind on skills",
    what: "A box's submenu: a \"Skills behind: …\" line naming the skills it lacks, and Sync Skills.",
    from: "tray/menu",
    via: "Hover a box row",
    files: [{ shoot: "pnpm shoot:tray tray/box-skills-behind.png --press agentbox.box.queue-retries" }],
  }),
  tray({
    id: "tray/accounts",
    title: "Tray: Accounts submenu",
    what: "The read-only list of LLM accounts per agent, with kind, identity and how many boxes use each.",
    from: "tray/menu",
    via: "Accounts",
    files: [{ shoot: "pnpm shoot:tray tray/accounts.png --press agentbox.footer.accounts" }],
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
    files: [{ shoot: "pnpm shoot:cli cli/ls.png --cols 122 --rows 22 -- ls --global" }],
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
