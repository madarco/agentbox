/* The demo scenarios. A scenario is the data set one fixture-hub request
   answers from, chosen per request (scripts/fixture-hub.mjs):

   full     acme.mjs as it is: every state at once (errors, limits, revoked
            logins, creating boxes, skills in every sync state). For planning
            and QA: "what does the UI do with X".
   simple   a calm, realistic day at Acme: one workspace, two projects, three
            healthy boxes, two comfortable subscriptions, four skills in sync.
            For social posts, demos and seeing the app as a normal user does.
   simple-* `simple` plus one change, so a picture tells one story.

   The story (names, numbers, titles) is shared with the tray's fixture mode;
   keep both telling the same one. Every scenario is a function of the base
   tables in acme.mjs, never a copy of them. */
import { createHash } from "node:crypto";
import {
  HOME,
  MACHINES,
  NOW,
  PROJECTS,
  S,
  accounts as fullAccounts,
  makeBoxSkills,
  makeBoxes,
  makeCustody,
  makeHubState,
  makeProjects,
  makeResolveSkills,
  makeUsage,
  pcSkill,
  seeds as fullSeeds,
  sha,
  skillMachines,
  ws,
} from "./acme.mjs";
import * as full from "./acme.mjs";

const iso = (m) => new Date(NOW - m * 60_000).toISOString();
const HOST = "studio-mac.local";
const PLAN = "mgr-fx-commerce-claude";

/* ---- simple ---- */

const SIMPLE_PROJECTS = ["fx-storefront-web", "fx-checkout-api"];

const SIMPLE_BOXES = [
  { id: "c41e07a95b2f", projectId: "fx-storefront-web", name: "checkout-copy", agent: "claude", status: "running", provider: "docker", host: "local · docker", age: 130, webUrl: "https://checkout-copy.localhost", branch: "agentbox/checkout-copy", activity: "working", title: "Tighten checkout copy for EU locales", managerId: PLAN, accounts: { claude: "work" }, pr: { repo: "acme/storefront-web", number: 409, url: "https://github.com/acme/storefront-web/pull/409", state: "open" }, commits: 3, files: 6, vnc: true, tasks: { total: 2, done: 1, current: { id: "T-3", title: "Tighten checkout copy for EU locales" } } },
  { id: "2b98d6f1e0a7", projectId: "fx-checkout-api", name: "fix-webhooks", agent: "codex", status: "running", provider: "hetzner", host: "hetzner · nbg1 · cx23", age: 205, webUrl: "https://fix-webhooks.localhost", branch: "agentbox/fix-webhooks", activity: "working", title: "Make Stripe webhook handlers idempotent", managerId: PLAN, accounts: { codex: "team" }, commits: 5, files: 8, tasks: { total: 3, done: 1, current: { id: "T-5", title: "Make Stripe webhook handlers idempotent" } } },
  { id: "a3c9e61d20f4", projectId: "fx-storefront-web", name: "perf-audit", agent: "claude", status: "paused", provider: "vercel", host: "vercel · iad1", age: 60 * 6, lastActive: 60 * 2 + 10, branch: "agentbox/perf-audit", activity: "idle", title: "Audit storefront page weight", managerId: PLAN, accounts: { claude: "work" }, pr: { repo: "acme/storefront-web", number: 405, url: "https://github.com/acme/storefront-web/pull/405", state: "merged" }, commits: 4, files: 7, tasks: { total: 1, done: 1, current: null } },
];

const SIMPLE_LIVE = {
  "checkout-copy": { doing: "Edit src/i18n/de.json", usage: { input: 1_400, output: 9_800, cacheRead: 1_120_000, cacheWrite: 61_000, contextTokens: 84_000, contextWindow: 200_000 } },
  "fix-webhooks": { doing: "bash: pnpm test webhooks", usage: { input: 162_000, output: 24_000, cacheRead: 0, cacheWrite: 0, reasoning: 13_000, contextTokens: 121_000, contextWindow: 272_000 } },
  "perf-audit": { usage: { input: 900, output: 7_100, cacheRead: 640_000, cacheWrite: 33_000, contextTokens: 58_000, contextWindow: 200_000 } },
};

const SIMPLE_SESSIONS = [
  S("claude", "work", "checkout-copy", "acme/storefront-web", "studio", "claude-sonnet-4-5", "Tighten checkout copy for EU locales", [[0, 64]]),
  S("codex", "team", "fix-webhooks", "acme/checkout-api", "studio", "gpt-5.1-codex", "Make Stripe webhook handlers idempotent", [[0, 96]]),
  S("claude", "work", "perf-audit", "acme/storefront-web", "studio", "claude-sonnet-4-5", "Audit storefront page weight", [[0, 58]]),
  S("claude", "work", null, "acme/storefront-web", "studio", "claude-opus-4-5", "Ship the EU checkout", [[4, 18], [3, 24], [2, 16], [1, 27], [0, 22]]),
];

/* A small team's sprint: two projects, Claude on the work plan and Codex on
   the team plan, about two new boxes a workday, one day each, and a quiet
   weekend. Nothing new today: today is the three live boxes. */
const SIMPLE_SCALE = {
  back: 60,
  refill: true,
  projects: [["acme/storefront-web", 3], ["acme/checkout-api", 2]],
  agents: [["claude", "work"], ["claude", "work"], ["codex", "team"]],
  fresh: (w, ago, rnd) => (ago === 0 || w < 0.2 ? 0 : Math.round(w * 2.8 + rnd() * 1.2)),
  days: (rnd, ago) => (ago <= 1 ? 1 : rnd() < 0.25 ? 2 : 1),
  hours: (w, rnd) => (1.4 + rnd() * 1.6) * (0.6 + w * 0.5),
  prBefore: { "acme/storefront-web": 405 },
  titles: {
    "acme/storefront-web": ["EU cookie banner copy", "Fix VAT line on the order summary", "Klarna badge on the PDP", "Localise size names for DE and FR", "Fix the empty-cart illustration on dark mode", "Shipping estimate under the CTA", "Trim unused Tailwind classes", "Fix the coupon field on Safari", "Preload the checkout fonts", "Fix the address autocomplete on mobile", "EU returns policy page", "Show delivery dates per country", "Fix the price flash on currency switch", "Bigger tap targets in the cart"],
    "acme/checkout-api": ["Log the Stripe event id on every webhook", "Reject duplicate order submissions", "VAT rates for Portugal and Ireland", "Faster GET /cart for big baskets", "Retry tax quotes on a timeout", "Health check for the Stripe client", "Fix the currency on refund emails", "Idempotency keys on POST /refunds", "Order export for the finance team", "Fix rounding on split payments", "Webhook signature check on every route", "Clean up expired payment intents"],
  },
};

/* A skill folder's version id, as the PC and the hub compute it (sandbox-core
   treeHash): one SKILL.md, mode 644. With it the CLI's own comparison of the
   scratch HOME's skills agrees with the fixture hub's. */
const treeOf = (content) => {
  const file = createHash("sha256").update(content).digest("hex");
  return createHash("sha256").update(`644 ${file} SKILL.md\n`).digest("hex");
};
const skillMdOf = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

const SKILL_TEXT = {
  "commit-style": ["Write commit messages the Acme way: imperative subject, why in the body.", "# Commit style\n\n- Subject in the imperative, under 60 characters.\n- Body says why, not what.\n- Reference the ticket as T-<n>."],
  "db-migrations": ["Write and check a Postgres migration, with a rollback, for the payments schema.", "# Database migrations\n\n1. Write the migration and its rollback.\n2. Run both against a scratch database.\n3. Note any lock it takes on a big table."],
  "review-pr": ["Review a pull request against the team checklist and leave inline comments.", "# Review a pull request\n\n1. Read every changed file in full.\n2. Walk through checklist.md.\n3. Post the findings as one review."],
  "e2e-playwright": ["Run and fix the storefront Playwright suite in a box.", "# Playwright suite\n\n1. Start the storefront with `pnpm dev`.\n2. Run `pnpm e2e` and read the failures.\n3. Fix the test or the page, never both at once."],
  "release-notes": ["Draft release notes from the commits since the last tag.", "# Release notes\n\n1. List commits since the last tag.\n2. Group them by area.\n3. One line per change, in the user's words."],
};
/* The newer copy on studio-mac (simple-skill-behind). */
const E2E_LOCAL = "# Playwright suite\n\n1. Start the storefront with `pnpm dev`.\n2. Run `pnpm e2e --project=chromium` and read the failures.\n3. Retry a failing test once with `--retries=1` before calling it broken.\n4. Fix the test or the page, never both at once.";

const GIT = { kind: "git", url: "https://github.com/acme/agent-skills.git", ref: "main" };
/* name, origin, policy, minutes since the hub's copy changed, PC folder */
const SIMPLE_SKILLS = [
  ["commit-style", { kind: "upload" }, "auto", 60 * 24 * 9, ".claude/skills"],
  ["db-migrations", { kind: "folder", linked: true, path: `${HOME}/Projects/commerce/.claude/skills/db-migrations`, host: HOST }, "auto", 60 * 26, ".claude/skills"],
  ["e2e-playwright", { ...GIT, path: "e2e-playwright", commit: sha("19ab0c") }, "auto", 60 * 24 * 12, ".agents/skills"],
  ["review-pr", { ...GIT, path: "review-pr", commit: sha("a91c3e") }, "auto", 60 * 24 * 3, ".agents/skills"],
];
const RELEASE_NOTES = ["release-notes", { kind: "marketplace", marketplace: "acme-tools", url: "https://github.com/acme/claude-plugins.git", plugin: "release", commit: sha("5e2f88") }, "manual", 45];

const hubSkill = ([name, origin, policy, age], i) => {
  const [description, body] = SKILL_TEXT[name];
  const content = skillMdOf(name, description, body);
  return { name, description, current: treeOf(content), size: content.length, files: 1, tarballBytes: 400 + content.length, updatedAt: iso(age), /* A marketplace skill came to the hub from the marketplace, not from a PC. */
    source: origin.kind === "marketplace" ? {} : { host: HOST, ...(origin.kind === "folder" ? { path: origin.path } : {}) }, versions: 2 + (i % 4), origin, policy };
};

/* The skills page's comparison of studio-mac, the shared rules
   (sandbox-core compareSkills) applied to the hub's skills and the PC's. */
const AGENTS_OF = { ".claude/skills": ["claude", "opencode"], ".agents/skills": ["codex", "opencode", "pi", "openclaw"] };
function compareOf(skills, pc) {
  const names = [...new Set([...skills.skills.map((s) => s.name), ...Object.keys(pc)])].sort();
  const rows = names.map((name) => {
    const h = skills.skills.find((s) => s.name === name);
    const l = pc[name];
    const hub = h && { current: h.current, updatedAt: h.updatedAt, pending: Boolean(h.pending) };
    const local = l && pcSkill(name, l.dir, { treeSha: treeOf(l.content), size: l.content.length, files: 1 });
    const status = !l ? "hub-only" : !h ? "local-only" : local.treeSha === h.current ? "same" : "differs";
    return {
      name,
      description: (h ?? l).description,
      status,
      ...(status === "differs" ? { newer: l.newer ? "local" : "hub" } : {}),
      agents: l ? AGENTS_OF[l.dir] : [],
      ...(hub ? { hub } : {}),
      ...(local ? { pc: local } : {}),
    };
  });
  const skipped = skills.skipped;
  return {
    [MACHINES.studio]: { machine: skillMachines.machines[0], outOfSync: rows.filter((r) => ["differs", "hub-only", "local-only"].includes(r.status)).length, skipped, rows },
    [MACHINES.laptop]: { machine: skillMachines.machines[1], error: "dev-laptop is offline", outOfSync: 0, skipped, rows: skills.skills.map((s) => ({ name: s.name, description: s.description, status: "unknown", agents: [], hub: { current: s.current, updatedAt: s.updatedAt, pending: Boolean(s.pending) } })) },
  };
}

/* Accounts as GET /accounts lists them: an entry of acme.mjs's, reshaped. */
const account = (agent, id, plan, boxes, windows) => {
  const base = fullAccounts.accounts.find((a) => a.agent === agent && a.id === id);
  return { ...base, default: { global: true }, identity: { ...base.identity, plan }, boxes, limits: { windows, atLimit: windows.some((w) => w.pct >= 100), updatedAt: iso(3), source: agent === "claude" ? "usage-api" : "transcript" } };
};

/* The pieces a scenario is made of; build() derives the rest. */
function simpleSpec() {
  const skillRows = SIMPLE_SKILLS;
  return {
    projects: PROJECTS.filter((p) => SIMPLE_PROJECTS.includes(p.id)),
    boxes: SIMPLE_BOXES,
    live: SIMPLE_LIVE,
    approvals: [],
    workspace: { open: 3, done: 6, managers: { running: 1, total: 1 } },
    accounts: [
      account("claude", "work", "Max", ["checkout-copy", "perf-audit"], [
        { id: "five_hour", label: "5-hour", pct: 38, resetsAt: iso(-140), windowMinutes: 300 },
        { id: "seven_day", label: "Weekly", pct: 52, resetsAt: iso(-60 * 24 * 3.6), windowMinutes: 10080 },
      ]),
      account("codex", "team", "Team", ["fix-webhooks"], [
        { id: "primary", label: "5-hour", pct: 12, resetsAt: iso(-210), windowMinutes: 300 },
        { id: "secondary", label: "Weekly", pct: 30, resetsAt: iso(-60 * 24 * 2.2), windowMinutes: 10080 },
      ]),
    ],
    skills: skillRows,
    /* What studio-mac holds: every hub skill, the same copy. */
    pc: Object.fromEntries(skillRows.map(([name, , , , dir]) => [name, { dir, description: SKILL_TEXT[name][0], content: skillMdOf(name, ...SKILL_TEXT[name]) }])),
    sessions: SIMPLE_SESSIONS,
    scale: SIMPLE_SCALE,
  };
}

function build(spec) {
  const projects = makeProjects(spec.projects);
  const boxes = makeBoxes(spec.boxes, spec.live, projects);
  const workspaces = [ws("fx-commerce", "Commerce", `${HOME}/Projects/commerce`, projects.map((p) => p.id), 12, { open: spec.workspace.open, done: spec.workspace.done }, spec.workspace.managers, projects)];
  const skills = { seeded: true, skipped: [], skills: spec.skills.map(hubSkill) };
  const skillStatus = { pending: [], boxes: [] };
  const skillBindings = { schema: 1, global: {}, workspace: {}, project: {}, box: {} };
  const resolveSkills = makeResolveSkills(skills, skillBindings);
  const seeds = Object.fromEntries(Object.entries(fullSeeds).filter(([id]) => projects.some((p) => p.id === id)));
  const { sessions, usageRows } = makeUsage(spec.sessions, boxes, {});
  const pcSkills = Object.entries(spec.pc).map(([name, l]) => ({ name, dir: l.dir, content: l.content }));
  return {
    ...full,
    projects,
    boxes,
    approvals: spec.approvals,
    workspaces,
    hubState: makeHubState({ projects, workspaces, boxes, approvals: spec.approvals }),
    accounts: { ...fullAccounts, accounts: spec.accounts },
    skills,
    skillSkips: [],
    skillStatus,
    skillBindings,
    resolveSkills,
    boxSkills: makeBoxSkills({ skills, skillStatus, resolveSkills, projects }),
    skillCompare: compareOf(skills, spec.pc),
    skillDiffs: {},
    skillMd: Object.fromEntries(spec.skills.map(([name]) => [name, skillMdOf(name, ...SKILL_TEXT[name])])),
    seeds,
    bots: {},
    custody: makeCustody({ skills, seeds }),
    sessions,
    usageRows,
    pcSkills,
    scale: spec.scale,
  };
}

/* ---- the variants: simple plus one change ---- */

function approvalSpec() {
  const s = simpleSpec();
  s.boxes = s.boxes.map((b) => (b.name === "fix-webhooks" ? { ...b, activity: "waiting" } : b));
  s.live = { ...s.live, "fix-webhooks": { ...s.live["fix-webhooks"], doing: "Waiting for approval: gh pr create" } };
  s.approvals = [
    {
      id: "fx-approval-simple",
      boxId: "2b98d6f1e0a7",
      kind: "confirm",
      message: 'gh pr create --title "Make Stripe webhook handlers idempotent"?',
      detail: "checkout-api · opens a pull request from agentbox/fix-webhooks",
      command: "gh pr create",
      cwd: "/workspace",
      argv: ["gh", "pr", "create", "--title", "Make Stripe webhook handlers idempotent", "--base", "main"],
      defaultAnswer: "y",
      createdAt: NOW - 2 * 60_000,
    },
  ];
  return s;
}

function skillBehindSpec() {
  const s = simpleSpec();
  s.pc = { ...s.pc, "e2e-playwright": { ...s.pc["e2e-playwright"], content: skillMdOf("e2e-playwright", SKILL_TEXT["e2e-playwright"][0], E2E_LOCAL), newer: true } };
  return s;
}

function skillNewSpec() {
  const s = simpleSpec();
  s.skills = [...s.skills, RELEASE_NOTES].sort((a, b) => a[0].localeCompare(b[0]));
  return s;
}

export const SCENARIOS = {
  full: { about: "Every state at once: errors, limits, revoked logins, skills in every sync state. For planning and QA.", data: () => ({ ...full, scale: undefined, pcSkills: null }) },
  simple: { about: "A calm day at Acme: Commerce, two projects, three healthy boxes, two comfortable plans, four skills in sync. For posts and demos.", data: () => build(simpleSpec()) },
  "simple-approval": { about: "simple, and fix-webhooks asks to run gh pr create.", data: () => build(approvalSpec()) },
  "simple-skill-behind": { about: "simple, and e2e-playwright changed on studio-mac: the Mac is newer than the Hub.", data: () => build(skillBehindSpec()) },
  "simple-skill-new": { about: "simple, and a fifth skill, release-notes, is new on the Hub and not on studio-mac yet.", data: () => build(skillNewSpec()) },
};

const cache = new Map();
/* One scenario's data, built once. Throws on an unknown name. */
export function dataFor(name = "full") {
  const s = SCENARIOS[name];
  if (!s) throw new Error(`unknown scenario "${name}": ${Object.keys(SCENARIOS).join(", ")}`);
  if (!cache.has(name)) cache.set(name, s.data());
  return cache.get(name);
}
