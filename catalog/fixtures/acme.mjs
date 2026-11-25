/* The made-up company every screen shows: Acme, a small team with a Commerce
   workspace (storefront-web, checkout-api, payments-worker), a Docs workspace,
   a Mobile workspace and one scratch project. Same ids, names and story as the
   tray's fixture mode (agentbox-tray Sources/AgentBox/Source/FixtureBoxSource.swift),
   so a hub screen and a tray screen of the same moment agree.

   Everything is relative to NOW, pinned so a screen taken twice is the same
   picture. Nothing here is a real box, repo, account or person. */

import { createHash } from "node:crypto";

export const NOW = Date.parse("2026-11-24T15:20:00Z");
const min = (m) => NOW - m * 60_000;
const iso = (m) => new Date(min(m)).toISOString();
/* Stable made-up hex (hashes, ids) from a seed string. */
const hex = (seed, len = 64) => {
  let out = "";
  for (let i = 0; out.length < len; i++) out += createHash("sha256").update(`${seed}:${i}`).digest("hex");
  return out.slice(0, len);
};

export const HOME = "/Users/dev";
const commerce = `${HOME}/Projects/commerce`;
const docsRoot = `${HOME}/Projects/docs-site`;
const mobile = `${HOME}/Projects/mobile`;
const HOST = "studio-mac.local";

export const projects = [
  { id: "fx-storefront-web", name: "storefront-web", repo: "acme/storefront-web", root: `${commerce}/storefront-web`, workspaceId: "fx-commerce", lastProvider: "vercel", lastAgent: "claude", currentBranch: "main" },
  { id: "fx-checkout-api", name: "checkout-api", repo: "acme/checkout-api", root: `${commerce}/checkout-api`, workspaceId: "fx-commerce", lastProvider: "hetzner", lastAgent: "codex", currentBranch: "main" },
  { id: "fx-payments-worker", name: "payments-worker", repo: "acme/payments-worker", root: `${commerce}/payments-worker`, workspaceId: "fx-commerce", lastProvider: "docker", lastAgent: "claude", currentBranch: "feat/charge-backoff" },
  { id: "fx-docs", name: "docs-site", repo: "acme/docs-site", root: docsRoot, workspaceId: "fx-docs", lastProvider: "docker", lastAgent: "opencode", currentBranch: "main" },
  { id: "fx-ios-app", name: "ios-app", repo: "acme/ios-app", root: `${mobile}/ios-app`, workspaceId: "fx-mobile", lastProvider: "docker", lastAgent: "claude", currentBranch: "main" },
  { id: "fx-android-app", name: "android-app", repo: "acme/android-app", root: `${mobile}/android-app`, workspaceId: "fx-mobile", lastProvider: "hetzner", lastAgent: "codex", currentBranch: "main" },
  { id: "fx-sandbox", name: "sandbox", repo: "sandbox", root: `${HOME}/Scratch/sandbox`, workspaceId: null, currentBranch: null, noGit: true },
].map((p, i) => ({
  id: p.id,
  name: p.name,
  repo: p.repo,
  defaultBranch: "main",
  workspaceId: p.workspaceId ?? undefined,
  currentBranch: p.currentBranch,
  needsSetup: false,
  provider: p.lastProvider ?? "docker",
  createdAt: min(60 * 24 * (20 - i)),
  originUrl: p.noGit ? null : `git@github.com:${p.repo}.git`,
  lastProvider: p.lastProvider ?? null,
  lastAgent: p.lastAgent ?? null,
  lastUsedAt: p.lastProvider ? min(30 + i * 40) : null,
  _root: p.root,
}));
const projectById = Object.fromEntries(projects.map((p) => [p.id, p]));

const PLAN = "mgr-fx-commerce-claude";
const COPY = "mgr-fx-commerce-codex";

/* name, project, agent, status/state, provider, host, created minutes ago, ... */
const raw = [
  { id: "7f3a9c21b8d4", projectId: "fx-payments-worker", name: "payment-retries", agent: "codex", status: "running", provider: "docker", host: "local · docker", age: 145, webUrl: "https://payment-retries.localhost", branch: "agentbox/payment-retries", activity: "working", title: "Retry failed charges with backoff", managerId: PLAN, pr: { repo: "acme/payments-worker", number: 412, url: "https://github.com/acme/payments-worker/pull/412", state: "open" }, commits: 4, files: 9, tasks: { total: 2, done: 0, current: { id: "T-16", title: "Integration tests for retry flow" } } },
  { id: "c41e07a95b2f", projectId: "fx-storefront-web", name: "checkout-copy", agent: "claude", status: "running", provider: "vercel", host: "vercel · iad1", age: 130, webUrl: "https://sb-4kq2x9.vercel.run", branch: "feat/checkout-copy", activity: "idle", title: "Tighten checkout copy for EU locales", managerId: PLAN, pr: { repo: "acme/storefront-web", number: 409, url: "https://github.com/acme/storefront-web/pull/409", state: "ready" }, accounts: { claude: "work" }, commits: 3, files: 6, vnc: true, tasks: { total: 2, done: 2, current: null } },
  { id: "2b98d6f1e0a7", projectId: "fx-checkout-api", name: "fix-webhooks", agent: "codex", status: "running", provider: "hetzner", host: "hetzner · nbg1 · cx23", age: 60 * 26, webUrl: "https://fix-webhooks.localhost", persistent: true, branch: "agentbox/fix-webhooks", activity: "thinking", title: "Make Stripe webhook handlers idempotent", managerId: PLAN, commits: 7, files: 14, accounts: { codex: "personal" }, tasks: { total: 3, done: 1, current: { id: "T-2", title: "Make webhook handlers idempotent" } } },
  { id: "9e5c3a7d14b6", projectId: "fx-payments-worker", name: "queue-retries", agent: "claude", status: "running", provider: "e2b", host: "e2b", age: 45, webUrl: "https://8080-i3kq2m9x.e2b.app", branch: "agentbox/queue-retries", activity: "waiting", title: "Move charge retries onto the job queue", managerId: PLAN, commits: 1, files: 3, tasks: { total: 1, done: 0, current: { id: "T-4", title: "Move charge retries onto the job queue" } } },
  { id: "job:q7k2m9", projectId: "fx-storefront-web", label: "promo-banner", agent: "opencode", status: "creating", provider: "docker", host: "local · docker", age: 2, managerId: PLAN },
  { id: "5d27b0c8f39e", projectId: "fx-storefront-web", name: "cart-badges", agent: "codex", status: "paused", provider: "docker", host: "local · docker", age: 60 * 5, branch: "fix/cart-badges", activity: "idle", title: "Cart badge count drifts after refresh", managerId: COPY, tasks: { total: 2, done: 0, current: { id: "T-6", title: "Fix cart badge count after a refresh" } }, commits: 2, files: 2 },
  { id: "a3c9e61d20f4", projectId: "fx-storefront-web", name: "perf-audit", agent: "claude", status: "running", provider: "docker", host: "local · docker", age: 20, webUrl: "https://perf-audit.localhost", branch: "agentbox/perf-audit", activity: "idle", title: "Audit storefront page weight", commits: 0, files: 0, vnc: true },
  { id: "job:r4t8w1", projectId: "fx-checkout-api", label: "refund-limits", agent: "claude", status: "error", provider: "e2b", host: "e2b", age: 30, error: "e2b base template not found: run agentbox prepare --provider e2b" },
  { id: "b6f14e92ad03", projectId: "fx-docs", name: "search-filters", agent: "opencode", status: "running", provider: "docker", host: "local · docker", age: 35, webUrl: "https://search-filters.localhost", branch: "agentbox/search-filters", activity: "working", title: "Add faceted search filters to the docs", commits: 2, files: 5 },
  { id: "e08a5c3f71b9", projectId: "fx-sandbox", name: "scratch", agent: "claude", status: "stopped", provider: "docker", host: "local · docker", age: 60 * 50, activity: "idle", hasGit: false, commits: null, files: null },
];

// Live status (docs/agent-live-status-plan.md): the working-on line and the
// current session's tokens, by box name. `doing` shows only while the agent is
// working, waiting or asking; an idle box keeps its usage.
const LIVE = {
  "payment-retries": { doing: "bash: pnpm test -- retry.spec.ts", usage: { input: 18_400, output: 9_200, cacheRead: 0, cacheWrite: 0, reasoning: 4_100, contextTokens: 61_000, contextWindow: 272_000 } },
  "checkout-copy": { usage: { input: 2_100, output: 14_300, cacheRead: 1_840_000, cacheWrite: 96_000, contextTokens: 118_000, contextWindow: 200_000 } },
  "fix-webhooks": { usage: { input: 240_000, output: 41_000, cacheRead: 0, cacheWrite: 0, reasoning: 22_000, contextTokens: 188_000, contextWindow: 272_000 } },
  "queue-retries": { doing: "Edit src/jobs/charge-retry.ts", usage: { input: 900, output: 5_600, cacheRead: 412_000, cacheWrite: 38_000, contextTokens: 52_000, contextWindow: 200_000 } },
  "cart-badges": { usage: { input: 31_000, output: 6_800, cacheRead: 0, cacheWrite: 0, contextTokens: 37_000, contextWindow: 272_000 } },
  "search-filters": { doing: "Read docs/search/facets.md", usage: { input: 46_000, output: 7_900, cacheRead: 210_000, cacheWrite: 0, contextTokens: 74_000, contextWindow: 200_000, costUsd: 0.38 } },
};

const ACCOUNT_INFO = {
  "claude:work": { label: "Acme work", kind: "login" },
  "claude:ci": { kind: "setup-token" },
  "codex:personal": { label: "Personal", kind: "api-key" },
};

export const boxes = raw.map((b) => {
  const p = projectById[b.projectId];
  const job = b.id.startsWith("job:");
  const running = b.status === "running";
  const box = {
    id: b.id,
    projectId: b.projectId,
    repo: p.name,
    branch: b.branch ?? (job ? "" : `agentbox/${b.name}`),
    task: b.title ?? b.name ?? b.label,
    displayName: null,
    agent: b.agent,
    status: b.status,
    createdAt: min(b.age),
    lastActivity: min(Math.min(b.age, b.activity === "idle" ? 12 : 1)),
    host: b.host,
    provider: b.provider,
    commits: job ? null : b.commits ?? null,
    filesTouched: job ? null : b.files ?? null,
    error: b.error ?? null,
    webUrl: running ? b.webUrl ?? null : null,
    vncUrl: running && b.vnc ? `https://${b.name}-vnc.localhost` : null,
  };
  if (job) return { ...box, name: b.label, task: b.label };
  Object.assign(box, {
    state: b.status,
    name: b.name,
    projectRoot: p._root,
    projectIndex: 0,
    vncEnabled: Boolean(b.vnc),
    persistent: Boolean(b.persistent),
    gitWorktrees: b.hasGit === false ? [] : [{ kind: "root", branch: box.branch }],
    hasGit: b.hasGit !== false,
    agentStatus: {
      [b.agent]: {
        state: b.activity ?? "idle",
        ...(b.title ? { sessionTitle: b.title } : {}),
        ...(LIVE[b.name]?.doing ? { activity: LIVE[b.name].doing } : {}),
        ...(LIVE[b.name]?.usage ? { usage: { ...LIVE[b.name].usage, updatedAt: new Date(min(1)).toISOString() } } : {}),
      },
    },
    [`${b.agent}SessionTitle`]: b.title,
    [`${b.agent}Activity`]: b.activity ?? "idle",
    shellCount: running ? 1 : 0,
    originUrl: p.originUrl,
    originMachineLabel: HOST,
    lastAgent: b.agent,
    agents: [b.agent],
  });
  if (b.tasks) box.tasks = b.tasks;
  if (b.managerId) box.managerId = b.managerId;
  if (b.pr) box.pr = b.pr;
  if (b.accounts) {
    box.accounts = b.accounts;
    box.accountsInfo = Object.entries(b.accounts).map(([agent, account]) => ({ agent, account, ...ACCOUNT_INFO[`${agent}:${account}`] }));
  }
  if (b.provider !== "docker") {
    box.sandboxId = { vercel: "sbx_4kq2x9TfL0", hetzner: "61840217", e2b: "i3kq2m9x" }[b.provider];
    box.topology = "cloud";
    if (b.provider === "hetzner") box.publicHost = "203.0.113.24";
  }
  return box;
});

export const approvals = [
  {
    id: "fx-approval-1",
    boxId: "b6f14e92ad03",
    kind: "confirm",
    message: "run pnpm docs:publish?",
    detail: "docs-site · uploads the preview build",
    command: "pnpm docs:publish",
    cwd: docsRoot,
    argv: ["pnpm", "docs:publish"],
    defaultAnswer: "n",
    createdAt: min(4),
  },
  {
    id: "fx-approval-2",
    boxId: "7f3a9c21b8d4",
    kind: "confirm",
    message: "git push origin agentbox/payment-retries?",
    detail: "payments-worker · 4 commits ahead of origin",
    command: "git push",
    cwd: "/workspace",
    argv: ["git", "push", "origin", "agentbox/payment-retries"],
    defaultAnswer: "y",
    createdAt: min(1),
  },
];

const ws = (id, name, root, projectIds, ageDays, counts, managers) => ({
  id,
  name,
  projects: projectIds.map((pid) => ({ id: pid, name: projectById[pid].name, repoUrl: projectById[pid].originUrl })),
  hosts: { [HOST]: { root, projectRoots: Object.fromEntries(projectIds.map((pid) => [pid, projectById[pid]._root])), seenAt: iso(1) } },
  root,
  projectIds,
  createdAt: iso(60 * 24 * ageDays),
  updatedAt: iso(3),
  taskCounts: counts,
  managers,
});

export const workspaces = [
  ws("fx-commerce", "Commerce", commerce, ["fx-storefront-web", "fx-checkout-api", "fx-payments-worker"], 12, { open: 7, done: 9 }, { running: 1, total: 2 }),
  ws("fx-docs", "Docs", docsRoot, ["fx-docs"], 20, { open: 2, done: 4 }, { running: 0, total: 1 }),
  ws("fx-mobile", "Mobile", mobile, ["fx-ios-app", "fx-android-app"], 2, { open: 1, done: 0 }, { running: 0, total: 0 }),
];

const ALL_CAPS = { checkpoints: true, checkpointReboots: false, ssh: true, persistentSsh: true, directBoxSsh: false, inbound: true, directGit: true, resync: true, prune: true, vnc: true, dind: true, pauseSemantics: "freeze", hubRoutable: true };
const prov = (id, label, kind, configured, extra = {}) => ({
  id,
  label,
  configured,
  kind,
  hasCredentials: configured || extra.hasCredentials === true,
  baseStatus: configured ? "fresh" : "unprepared",
  capabilities: { ...ALL_CAPS, ...(extra.caps ?? {}) },
  bake: { required: kind === "cloud", approxMinutes: kind === "cloud" ? "4-8" : "2" },
  credentials: { envKeys: extra.envKeys ?? [], fields: (extra.envKeys ?? []).map((k) => ({ key: k, label: k })) },
  ...(extra.reason ? { reason: extra.reason } : {}),
  ...(extra.sizes ? { sizes: extra.sizes } : {}),
  ...(extra.regions ? { regions: extra.regions } : {}),
});

export const providers = [
  prov("docker", "Docker", "local", true),
  prov("hetzner", "Hetzner Cloud", "cloud", true, { envKeys: ["HCLOUD_TOKEN"], sizes: [{ key: "cx23", label: "cx23 · 2 vCPU · 4 GB" }, { key: "cx33", label: "cx33 · 4 vCPU · 8 GB" }], regions: [{ key: "nbg1", label: "Nuremberg" }, { key: "fsn1", label: "Falkenstein" }] }),
  prov("vercel", "Vercel Sandbox", "cloud", true, { envKeys: ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"], caps: { ssh: false, persistentSsh: false } }),
  prov("e2b", "E2B", "cloud", false, { envKeys: ["E2B_API_KEY"], hasCredentials: true, reason: "Base template not built yet: run agentbox prepare --provider e2b", caps: { ssh: false, persistentSsh: false } }),
  prov("daytona", "Daytona", "cloud", false, { envKeys: ["DAYTONA_API_KEY"], reason: "No API key on this machine" }),
  prov("digitalocean", "DigitalOcean", "cloud", false, { envKeys: ["DIGITALOCEAN_TOKEN"], reason: "No API token on this machine" }),
];

export const hubState = {
  user: { login: "maya", name: "Maya" },
  github: { available: false, installed: false, appName: "GitHub App", account: "", installedAt: 0, repos: [] },
  projects: projects.map(({ _root, ...p }) => p),
  workspaces,
  boxes,
  approvals,
  providers,
  authMode: "off",
  controlPlane: null,
};

/* ---- LLM accounts (GET /api/v1/accounts) ---- */
export const accounts = {
  accounts: [
    { agent: "claude", id: "work", label: "Acme work", kind: "login", identity: { email: "dev@acme.example", org: "Acme", plan: "Max" }, hasSecret: true, boxes: ["checkout-copy"], createdAt: iso(60 * 24 * 9), updatedAt: iso(60 * 3) },
    { agent: "claude", id: "ci", kind: "setup-token", hasSecret: true, boxes: [], createdAt: iso(60 * 24 * 4), updatedAt: iso(60 * 24 * 4) },
    { agent: "codex", id: "personal", label: "Personal", kind: "api-key", hasSecret: true, boxes: ["fix-webhooks"], createdAt: iso(60 * 24 * 6), updatedAt: iso(60 * 24 * 6) },
    { agent: "codex", id: "team", label: "Acme team", kind: "login", identity: { email: "eng@acme.example", plan: "Team" }, hasSecret: true, boxes: [], createdAt: iso(60 * 24 * 2), updatedAt: iso(60 * 30) },
  ],
  agents: [
    { id: "claude", label: "Claude Code", kinds: ["login", "setup-token", "api-key"] },
    { id: "codex", label: "Codex", kinds: ["login", "api-key"] },
    { id: "opencode", label: "OpenCode", kinds: ["api-key"] },
  ],
};

/* ---- Skills (GET /api/v1/skills, /api/v1/skill-status) ---- */
/* A 40-hex sha that starts with the readable prefix given. */
const sha = (s) => (s + hex(s, 40)).slice(0, 40);
export const skills = {
  seeded: true,
  skills: [
    { name: "review-pr", description: "Review a pull request against the team checklist and leave inline comments.", current: sha("0d9e8f7a6b5c4d3e2f1a"), size: 18_432, files: 4, tarballBytes: 6_210, updatedAt: iso(60 * 24 * 3), source: { host: HOST, path: `${HOME}/.claude/skills/review-pr` }, versions: 5, origin: { kind: "git", url: "https://github.com/acme/agent-skills.git", ref: "main", path: "review-pr", commit: sha("a91c3e") }, policy: "manual", pending: { version: "4e1f0a9c7b3d52e8a6f1c0d94b7e2a3518c6f0d2", uploadedAt: iso(50), size: 19_880, files: 4, commit: sha("c07d21") } },
    { name: "release-notes", description: "Draft release notes from the commits since the last tag.", current: sha("71b0c9d8e7f6"), size: 7_120, files: 2, tarballBytes: 2_904, updatedAt: iso(60 * 24 * 8), source: { host: HOST }, versions: 3, origin: { kind: "marketplace", marketplace: "acme-tools", url: "https://github.com/acme/claude-plugins.git", plugin: "release", commit: sha("5e2f88") }, policy: "manual", pending: { version: "b7c3e91d05a4f6280e3b1c7d9a52f4e6018b3c7a", uploadedAt: iso(140), size: 7_480, files: 2 } },
    { name: "db-migrations", description: "Write and check a Postgres migration, with a rollback, for the payments schema.", current: sha("e3d2c1b0a9f8"), size: 11_904, files: 3, tarballBytes: 4_400, updatedAt: iso(60 * 5), source: { host: HOST, path: `${HOME}/Projects/commerce/.claude/skills/db-migrations` }, versions: 7, origin: { kind: "folder", linked: true, path: `${HOME}/Projects/commerce/.claude/skills/db-migrations`, host: HOST }, policy: "auto" },
    { name: "stripe-webhooks", description: "How Acme verifies, dedupes and replays Stripe webhook events.", current: sha("9a8b7c6d5e4f"), size: 9_216, files: 2, tarballBytes: 3_310, updatedAt: iso(60 * 24), source: { host: HOST }, versions: 2, origin: { kind: "upload" }, policy: "auto" },
    { name: "e2e-playwright", description: "Run and fix the storefront Playwright suite in a box.", current: sha("4c3b2a19f0e8"), size: 14_880, files: 5, tarballBytes: 5_020, updatedAt: iso(60 * 24 * 12), source: { host: HOST }, versions: 1, origin: { kind: "git", url: "https://github.com/acme/agent-skills.git", ref: "main", path: "e2e-playwright", commit: sha("19ab0c") }, policy: "auto" },
  ],
};

export const skillStatus = {
  pending: [
    { name: "review-pr", version: "4e1f0a9c7b3d52e8a6f1c0d94b7e2a3518c6f0d2" },
    { name: "release-notes", version: "b7c3e91d05a4f6280e3b1c7d9a52f4e6018b3c7a" },
  ],
  boxes: [{ boxId: "9e5c3a7d14b6", behind: ["db-migrations", "review-pr"] }],
};

/* ---- Box detail panels (GET /api/v1/boxes/{id}/git|services|skills) ---- */

/* What `agentbox open --targets` reports on studio-mac: everything but Herdr. */
const PERSISTENT_SSH = ["docker", "hetzner", "remote-docker", "digitalocean"];
const SSH = ["docker", "hetzner", "daytona", "remote-docker", "digitalocean"];
export const openTargets = {
  supported: true,
  targets: {
    claude: { available: true, providers: PERSISTENT_SSH },
    codex: { available: true, providers: PERSISTENT_SSH },
    herdr: { available: false, reason: "Herdr is not installed" },
    cmux: { available: true },
    vscode: { available: true, providers: SSH },
    iterm2: { available: true },
    finder: { available: true, providers: SSH },
  },
};

export function boxGit(b) {
  if (b.status !== "running") return { ok: false, error: `box is ${b.status}` };
  return { ok: true, branch: b.branch, dirty: ["working", "thinking"].includes(b[`${b.agent}Activity`]), ahead: b.commits ?? 0, behind: b.id === "2b98d6f1e0a7" ? 2 : 0 };
}

const svc = (name, state, command, extra = {}) => ({ name, state, pid: null, restarts: 0, lastExitCode: null, blockedOn: [], command, probed: false, ...extra });
/* agentbox.yaml services per project, as a running box reports them. */
const SERVICES = {
  "fx-payments-worker": {
    services: [
      svc("postgres", "ready", "docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:16", { probed: true }),
      svc("web", "ready", "pnpm --filter dashboard dev --port 3000", { probed: true }),
      svc("worker", "running", "pnpm --filter worker dev", { restarts: 1, lastExitCode: 1 }),
    ],
    tasks: [{ name: "install", state: "done" }, { name: "migrate", state: "done" }],
    ports: [{ port: 3000, service: "web" }, { port: 5432, service: "postgres" }],
  },
  "fx-checkout-api": {
    services: [
      svc("postgres", "ready", "docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:16", { probed: true }),
      svc("stripe-mock", "ready", "docker run --rm -p 12111:12111 stripe/stripe-mock:latest", { probed: true }),
      svc("api", "ready", "pnpm dev --port 8080", { probed: true }),
    ],
    tasks: [{ name: "install", state: "done" }, { name: "migrate", state: "done" }],
    ports: [{ port: 8080, service: "api" }, { port: 5432, service: "postgres" }, { port: 12111, service: "stripe-mock" }],
  },
  "fx-storefront-web": {
    services: [
      svc("api-mock", "ready", "pnpm mock:api --port 4010", { probed: true }),
      svc("web", "ready", "pnpm dev --port 3000", { probed: true }),
    ],
    tasks: [{ name: "install", state: "done" }],
    ports: [{ port: 3000, service: "web" }, { port: 4010, service: "api-mock" }],
  },
  "fx-docs": {
    services: [svc("docs", "ready", "pnpm dev --port 3000", { probed: true })],
    tasks: [{ name: "install", state: "done" }, { name: "build-index", state: "done" }],
    ports: [{ port: 3000, service: "docs" }],
  },
};

export function boxServices(b) {
  const decl = SERVICES[b.projectId];
  if (b.id.startsWith("job:") || b.status === "stopped" || !decl) return { source: "unavailable", services: [], tasks: [], ports: [] };
  if (b.status !== "running") return { ...decl, source: "persisted", services: decl.services.map((s) => ({ ...s, pid: null })) };
  let pid = 400 + parseInt(b.id.slice(0, 2), 16);
  return { ...decl, source: "live", services: decl.services.map((s) => ({ ...s, pid: (pid += 37) })) };
}

/* ---- Skill bindings (GET /api/v1/skill-bindings, …/resolve) ---- */
const repoKeyOf = (p) => (p.repo.includes("/") ? `github.com/${p.repo}` : undefined);
export const skillBindings = {
  schema: 1,
  global: { "stripe-webhooks": "exclude", "db-migrations": "exclude" },
  workspace: { "fx-docs": { "e2e-playwright": "exclude" } },
  project: {
    "github.com/acme/payments-worker": { "stripe-webhooks": "include", "db-migrations": "include", "e2e-playwright": "exclude" },
    "github.com/acme/checkout-api": { "stripe-webhooks": "include", "db-migrations": "include", "e2e-playwright": "exclude" },
  },
  box: { "7f3a9c21b8d4": { "release-notes": "exclude" } },
};

/* Most specific wins: box > project > workspace > global; bound nowhere = included. */
export function resolveSkills({ boxId, projectKey, workspaceId }) {
  return skills.skills.map(({ name, description }) => {
    const layers = [
      ["box", boxId && skillBindings.box[boxId]],
      ["project", projectKey && skillBindings.project[projectKey]],
      ["workspace", workspaceId && skillBindings.workspace[workspaceId]],
      ["global", skillBindings.global],
    ];
    for (const [from, map] of layers) if (map && map[name]) return { name, description, included: map[name] === "include", from };
    return { name, description, included: true, from: "default" };
  });
}

const OLD_VERSION = { "review-pr": sha("8a7b6c5d4e3f2a1b"), "db-migrations": sha("c2b1a0f9e8d7") };
export function boxSkills(b) {
  const p = projectById[b.projectId];
  const behind = new Set(skillStatus.boxes.find((x) => x.boxId === b.id)?.behind ?? []);
  const held = resolveSkills({ boxId: b.id, projectKey: p && repoKeyOf(p), workspaceId: p?.workspaceId }).filter((s) => s.included);
  return {
    boxId: b.id,
    recordedAt: new Date(b.createdAt + 60_000).toISOString(),
    skills: held.map(({ name }) => {
      const lib = skills.skills.find((s) => s.name === name);
      const lag = behind.has(name);
      return { name, version: lag ? OLD_VERSION[name] : lib.current, ...(lag ? { current: lib.current } : {}), ...(lib.pending ? { pending: lib.pending.version } : {}), behind: lag };
    }),
  };
}

/* ---- Project seeds + bot backups (GET /api/v1/projects/{id}/seed|bots) ---- */
const seedEntry = (slug, name, size, ageMin) => ({ name, size, sha256: hex(`${slug}/${name}`), updatedAt: iso(ageMin) });
const SEEDS = {
  "fx-payments-worker": { age: 60 * 3, branch: "feat/charge-backoff", untracked: 48_211, env: 1_204 },
  "fx-checkout-api": { age: 60 * 27, branch: "main", untracked: 12_880, env: 2_316 },
  "fx-storefront-web": { age: 60 * 50, branch: "main", untracked: 206_540, env: 988 },
  "fx-docs": { age: 60 * 24 * 6, branch: "main", untracked: 3_402 },
  "fx-ios-app": { age: 60 * 24 * 2, branch: "main", untracked: 91_330, env: 1_640 },
};
export const seeds = Object.fromEntries(
  Object.entries(SEEDS).map(([id, s]) => {
    const p = projectById[id];
    const slug = repoKeyOf(p).split("/").join("__");
    const entries = [
      ...(s.env ? [seedEntry(slug, "env.tar.gz", s.env, s.age)] : []),
      seedEntry(slug, "manifest.json", 612, s.age),
      seedEntry(slug, "untracked.tar.gz", s.untracked, s.age),
    ];
    return [id, {
      slug,
      originUrl: p.originUrl,
      baseBranch: s.branch,
      repoHeadSha: hex(`${slug}:head`, 40),
      capturedAt: iso(s.age),
      hasEnv: Boolean(s.env),
      hasUntracked: true,
      totalBytes: entries.reduce((n, e) => n + e.size, 0),
      entries,
    }];
  }),
);

/* A dunning bot (an openclaw service box) this project backs up nightly. */
const stamp = (m) => iso(m).replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
export const bots = {
  "fx-payments-worker": [
    {
      bot: "dunning-bot",
      latest: stamp(60 * 13 + 7),
      backups: [
        { stamp: stamp(60 * 13 + 7), agent: "openclaw", state: true, boxName: "dunning-bot", provider: "docker" },
        { stamp: stamp(60 * 37 + 4), agent: "openclaw", state: true, boxName: "dunning-bot", provider: "docker" },
        { stamp: stamp(60 * 24 * 6), agent: "openclaw", state: false, boxName: "dunning-bot", provider: "docker" },
      ],
    },
  ],
};

/* ---- Custody (GET /api/v1/custody): metadata only, never a value ---- */
const entry = (path, size, ageMin, mode = 0o600) => ({ path, size, sha256: hex(path), mode, updatedAt: iso(ageMin) });
export const custody = {
  enabled: true,
  entries: [
    entry("agents/claude/.claude.json", 4_812, 60 * 3),
    entry("agents/claude/.credentials.json", 1_116, 60 * 3),
    entry("agents/codex/auth.json", 2_405, 60 * 30),
    entry("agents/codex/config.toml", 318, 60 * 24 * 6, 0o644),
    entry("agents/opencode/auth.json", 744, 60 * 24 * 9),
    ...Object.values(seeds).flatMap((s) => s.entries.map((e) => entry(`projects/${s.slug}/seed/${e.name}`, e.size, (NOW - Date.parse(e.updatedAt)) / 60_000))),
    entry("prepared/docker.json", 1_906, 60 * 24 * 2, 0o644),
    entry("prepared/hetzner.json", 1_388, 60 * 24 * 4, 0o644),
    entry("prepared/vercel.json", 1_352, 60 * 24 * 4, 0o644),
    entry("skills/.seeded", 25, 60 * 24 * 14, 0o644),
    ...skills.skills.flatMap((s) => [
      entry(`skills/${s.name}/meta.json`, 380 + s.versions * 120, (NOW - Date.parse(s.updatedAt)) / 60_000, 0o644),
      entry(`skills/${s.name}/${s.current}.tar.gz`, s.tarballBytes, (NOW - Date.parse(s.updatedAt)) / 60_000, 0o644),
      ...(s.pending ? [entry(`skills/${s.name}/${s.pending.version}.tar.gz`, Math.round(s.tarballBytes * 1.07), (NOW - Date.parse(s.pending.uploadedAt)) / 60_000, 0o644)] : []),
    ]),
    entry("boxes/2b98d6f1e0a7/id_ed25519", 411, 60 * 26),
    entry("boxes/2b98d6f1e0a7/id_ed25519.pub", 97, 60 * 26, 0o644),
  ],
};

/* ---- System & Build (GET /api/v1/system) ---- */
const FINGERPRINT = hex("box-context", 12);
const bake = (id, label, ageMin, imageRef) => ({ id, label, baked: true, fingerprint: hex(`${id}-context`, 12), cliVersion: "0.34.0", bakedAt: iso(ageMin), imageRef, baseStatus: "fresh" });
export const system = {
  hub: { version: "0.34.0", commit: null, profile: "localhost", apiVersion: "v1" },
  build: { version: "0.34.0", channel: "stable", build: "@madarco/agentbox@0.34.0 (npm)" },
  deploy: { provider: "local", url: "https://hub.acme.example", publicUrl: "https://hub.acme.example", tunnel: "cloudflare", autostart: true, port: 8787, bind: "127.0.0.1" },
  providers: [
    { ...bake("docker", "Docker", 60 * 24 * 2, "agentbox/box:dev"), fingerprint: FINGERPRINT },
    { id: "daytona", label: "Daytona", baked: false, baseStatus: "unprepared" },
    bake("hetzner", "Hetzner", 60 * 24 * 4, "snapshot 318840215"),
    bake("vercel", "Vercel", 60 * 24 * 4, "snap_9QwE2rTyU4iO"),
    { id: "e2b", label: "E2B", baked: false, baseStatus: "unprepared" },
    { id: "digitalocean", label: "DigitalOcean", baked: false, baseStatus: "unprepared" },
  ],
  hostCarried: [
    { agent: "agents", label: "Shared agent skills", hostPath: "~/.agents", kind: "skills", skills: ["e2e-playwright", "review-pr"] },
    { agent: "claude", label: "Claude", hostPath: "~/.claude", kind: "skills", skills: ["db-migrations", "release-notes", "stripe-webhooks"] },
    { agent: "codex", label: "Codex", hostPath: "~/.codex", kind: "config" },
    { agent: "opencode", label: "OpenCode", hostPath: "~/.config/opencode", kind: "config" },
    { agent: "claude", label: "Claude project config", hostPath: "~/.claude.json", kind: "config" },
    { agent: "git", label: "Git identity", hostPath: "~/.gitconfig", kind: "identity" },
  ],
  boxImage: { registry: "ghcr.io/madarco/agentbox/box", pullTag: `sha-${FINGERPRINT}`, stampedFingerprint: FINGERPRINT, imageRef: "agentbox/box:dev", bakedAt: iso(60 * 24 * 2) },
};

/* ---- Devices (GET /api/v1/devices, …/pending): the PCs enrolled with `hub login` ---- */
export const MACHINES = { studio: hex("studio-mac", 32), laptop: hex("dev-laptop", 32), ci: hex("ci-runner", 32), old: hex("old-imac", 32), build: hex("build-server", 32) };
export const devices = {
  devices: [
    { id: MACHINES.studio, label: HOST, createdAt: iso(60 * 24 * 21), lastSeenAt: iso(0.2), revokedAt: null, userId: null },
    { id: MACHINES.laptop, label: "dev-laptop", createdAt: iso(60 * 24 * 12), lastSeenAt: iso(60 * 4), revokedAt: null, userId: null },
    { id: MACHINES.ci, label: "ci-runner", createdAt: iso(60 * 24 * 6), lastSeenAt: iso(18), revokedAt: null, userId: null },
    { id: MACHINES.old, label: "old-imac", createdAt: iso(60 * 24 * 40), lastSeenAt: iso(60 * 24 * 16), revokedAt: iso(60 * 24 * 15), userId: null },
  ],
  current: null,
};
export const pendingDevices = {
  pending: [
    { userCode: "K7QP-M4XD", deviceId: MACHINES.build, label: "build-server", createdAt: iso(2), expiresAt: iso(-13), reenroll: false, proven: false, sourceIp: "198.51.100.23" },
  ],
};

/* ---- Usage (GET /api/v1/usage) ----
   Recorded sessions, each expanded into one row per (session, day, model): the
   real report sums usage rows, and these are their pre-summed stand-ins. Per
   response averages follow each agent's shape (Claude Code lives off cache
   reads; Codex counts uncached input and writes no cache). */
const PER_RESPONSE = {
  claude: { input: 42, output: 610, cacheRead: 61_000, cacheWrite: 2_900 },
  codex: { input: 7_400, output: 880, cacheRead: 39_000, cacheWrite: 0 },
  opencode: { input: 1_900, output: 520, cacheRead: 27_000, cacheWrite: 1_700 },
};
const DAY = 86_400_000;
const DESTROYED = { "refund-api": "d41b7e09c3a2", "stripe-sdk-v17": "e7c20f5a91d8", "sitemap-split": "1a9e4c7b2f60", "eu-vat-rules": "f03d8b6e2c19", "ios-push-tokens": "6b2e9f1d7c48", "anr-crash": "93c5a0e8b7f1" };
const S = (agent, account, box, project, host, model, title, days) => ({ agent, account, box, project, host, model, title, days });
/* days: [days ago, responses]; today (0) is cut off at NOW. */
const SESSIONS = [
  S("claude", "work", "checkout-copy", "acme/storefront-web", "studio", "claude-sonnet-4-5", "Tighten checkout copy for EU locales", [[0, 96]]),
  S("codex", "team", "payment-retries", "acme/payments-worker", "studio", "gpt-5.1-codex", "Retry failed charges with backoff", [[0, 132]]),
  S("codex", "personal", "fix-webhooks", "acme/checkout-api", "studio", "gpt-5.1-codex", "Make Stripe webhook handlers idempotent", [[1, 214], [0, 88]]),
  S("claude", "work", "queue-retries", "acme/payments-worker", "studio", "claude-opus-4-5", "Move charge retries onto the job queue", [[0, 54]]),
  S("codex", "team", "cart-badges", "acme/storefront-web", "laptop", "gpt-5.1-codex-mini", "Cart badge count drifts after refresh", [[0, 61]]),
  S("claude", "work", "perf-audit", "acme/storefront-web", "studio", "claude-sonnet-4-5", "Audit storefront page weight", [[0, 23]]),
  S("opencode", "default", "search-filters", "acme/docs-site", "studio", "claude-sonnet-4-5", "Add faceted search filters to the docs", [[0, 40]]),
  S("claude", "work", null, "acme/payments-worker", "studio", "claude-opus-4-5", "Plan the Commerce sprint", [[6, 38], [5, 22], [3, 31], [1, 44], [0, 29]]),
  S("claude", "ci", null, "acme/storefront-web", "ci", "claude-haiku-4-5", "Nightly dependency check", [[7, 18], [6, 17], [5, 19], [4, 16], [3, 18], [2, 17], [1, 19]]),
  S("claude", "work", "refund-api", "acme/checkout-api", "studio", "claude-opus-4-5", "Partial refunds endpoint", [[7, 120], [6, 188], [5, 96]]),
  S("codex", "personal", "stripe-sdk-v17", "acme/checkout-api", "laptop", "gpt-5.1-codex", "Upgrade to stripe-node v17", [[6, 152], [5, 74]]),
  S("claude", "work", "sitemap-split", "acme/storefront-web", "studio", "claude-sonnet-4-5", "Split the sitemap per locale", [[5, 140], [4, 66]]),
  S("claude", "work", "eu-vat-rules", "acme/checkout-api", "studio", "claude-opus-4-5", "EU VAT rules for B2B orders", [[4, 210], [1, 160]]),
  S("codex", "team", "ios-push-tokens", "acme/ios-app", "laptop", "gpt-5.1-codex", "Rotate stale APNs push tokens", [[4, 118], [3, 41]]),
  S("opencode", "default", "anr-crash", "acme/android-app", "laptop", "claude-sonnet-4-5", "ANR on the order history screen", [[2, 37], [1, 92]]),
  S("claude", "work", null, "acme/docs-site", "laptop", "claude-sonnet-4-5", "Docs IA review", [[2, 26], [1, 12]]),
  S("codex", "personal", null, "acme/checkout-api", "studio", "gpt-5.1-codex-mini", "Explain the ledger tables", [[4, 22], [1, 15]]),
  S("claude", "work", "release-1-14", "acme/storefront-web", "studio", "claude-sonnet-4-5", "Cut storefront 1.14", [[13, 84], [12, 40]]),
  S("codex", "team", "ledger-backfill", "acme/payments-worker", "laptop", "gpt-5.1-codex", "Backfill ledger entries for March", [[19, 160], [18, 88]]),
  S("claude", "work", "a11y-pass", "acme/storefront-web", "studio", "claude-opus-4-5", "Accessibility pass on checkout", [[25, 130]]),
];
const boxIdByName = { ...Object.fromEntries(boxes.filter((b) => b.name).map((b) => [b.name, b.id])), ...DESTROYED, "release-1-14": "2c7d91e4a0b3", "ledger-backfill": "84f0b6d2e9a1", "a11y-pass": "5e1a3c8f7b02" };
const startOfDay = (ms) => ms - (ms % DAY);

export const usageRows = SESSIONS.flatMap((s, si) => {
  const sessionKey = `${s.agent}:${hex(`session-${si}`, 8)}-${hex(`s${si}a`, 4)}-4${hex(`s${si}b`, 3)}-a${hex(`s${si}c`, 3)}-${hex(`s${si}d`, 12)}`;
  const avg = PER_RESPONSE[s.agent];
  return s.days.map(([ago, messages], di) => {
    /* A little spread so two equal days don't look copy-pasted. */
    const jitter = 0.82 + ((parseInt(hex(`${si}-${di}`, 4), 16) % 360) / 1000);
    const n = (v) => Math.round(v * messages * jitter);
    const at = ago === 0 ? NOW - 40 * 60_000 : startOfDay(NOW) - ago * DAY + 14 * 3_600_000;
    return {
      at,
      session: sessionKey,
      title: s.title,
      agent: s.agent,
      account: s.account,
      box: s.box ? boxIdByName[s.box] : null,
      boxName: s.box,
      project: `github.com/${s.project}`,
      projectUrl: `git@github.com:${s.project}.git`,
      host: MACHINES[s.host],
      model: s.model,
      inputTokens: n(avg.input),
      outputTokens: n(avg.output),
      cacheReadTokens: n(avg.cacheRead),
      cacheWriteTokens: n(avg.cacheWrite),
      messages,
    };
  });
});

/* ---- Skill update diffs (GET /api/v1/skills/{name}/diff) ---- */
const REVIEW_PR_BEFORE = `---
name: review-pr
description: Review a pull request against the team checklist and leave inline comments.
---

# Review a pull request

1. Fetch the PR with \`gh pr view <number> --json files,commits,body\`.
2. Read every changed file in full, not only the hunks.
3. Walk through checklist.md and note each item that fails.
4. Leave one inline comment per finding with \`gh pr review --comment\`.
5. Finish with a summary comment: blocking findings first, then nits.

Keep comments short and specific. Quote the line you mean.
Do not approve a PR; a person does that.`;
const REVIEW_PR_AFTER = `---
name: review-pr
description: Review a pull request against the team checklist and leave inline comments.
---

# Review a pull request

1. Fetch the PR with \`gh pr view <number> --json files,commits,body,labels\`.
2. Read every changed file in full, not only the hunks.
3. Run the project's tests for the touched packages (\`pnpm test --filter <pkg>\`).
4. Walk through checklist.md and note each item that fails.
5. Post the findings in one review with scripts/post-review.sh, so the author
   gets a single notification instead of one per comment.
6. Finish with a summary: blocking findings first, then nits.

Keep comments short and specific. Quote the line you mean.
Skip PRs labelled \`wip\`.
Do not approve a PR; a person does that.`;
const CHECKLIST_BEFORE = `# Review checklist

- [ ] Money is handled in integer minor units, never floats
- [ ] Every new endpoint checks the caller's account
- [ ] Database changes ship with a migration and a rollback
- [ ] Webhook handlers are idempotent
- [ ] New config has a default and is documented
- [ ] Errors are logged with the request id`;
const CHECKLIST_AFTER = `# Review checklist

- [ ] Money is handled in integer minor units, never floats
- [ ] Every new endpoint checks the caller's account
- [ ] Database changes ship with a migration and a rollback
- [ ] Webhook handlers are idempotent (dedupe on the event id)
- [ ] Retries use backoff with a cap, and are safe to repeat
- [ ] New config has a default and is documented
- [ ] Errors are logged with the request id
- [ ] No secrets or customer data in logs or fixtures`;
const POST_REVIEW = `#!/usr/bin/env bash
# Post every finding as one review, so the author gets one notification.
# usage: post-review.sh <pr-number> <findings.json>
set -euo pipefail
pr="$1"
findings="$2"
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
jq '{event: "COMMENT", body: .summary, comments: [.findings[] | {path, line, body}]}' "$findings" |
  gh api "repos/$repo/pulls/$pr/reviews" --input -`;
const COMMENT_STYLE = `# Comment style

- Lead with the problem, then the fix.
- One finding per comment.
- Mark nits with "nit:".`;

export const skillDiffs = {
  "review-pr": {
    findings: [],
    files: [
      { path: "SKILL.md", status: "modified", before: REVIEW_PR_BEFORE, after: REVIEW_PR_AFTER },
      { path: "checklist.md", status: "modified", before: CHECKLIST_BEFORE, after: CHECKLIST_AFTER },
      { path: "comment-style.md", status: "removed", before: COMMENT_STYLE },
      { path: "scripts/post-review.sh", status: "added", after: POST_REVIEW },
    ],
  },
  "release-notes": {
    findings: [],
    files: [
      {
        path: "SKILL.md",
        status: "modified",
        before: "---\nname: release-notes\ndescription: Draft release notes from the commits since the last tag.\n---\n\n1. List commits with `git log <last-tag>..HEAD --oneline`.\n2. Group them by area.\n3. Write one line per change.",
        after: "---\nname: release-notes\ndescription: Draft release notes from the commits since the last tag.\n---\n\n1. List commits with `git log <last-tag>..HEAD --oneline --no-merges`.\n2. Group them by area: Features, Fixes, Internal.\n3. Write one line per change, in the user's words.\n4. Leave Internal out of the public notes.",
      },
    ],
  },
};
export const skillMd = { "review-pr": REVIEW_PR_BEFORE };

/* The skills page's machine column (GET /api/v1/skill-machines[/{id}/compare]):
   studio-mac is the hub's own machine; dev-laptop is enrolled and offline. */
export const skillMachines = {
  machines: [
    { id: MACHINES.studio, label: HOST, self: true, online: true },
    { id: MACHINES.laptop, label: "dev-laptop", self: false, online: false },
  ],
  defaultId: MACHINES.studio,
};

const pcSkill = (name, dir, extra = {}) => ({
  treeSha: sha(name), dirs: [dir], path: `${HOME}/${dir}/${name}`, size: 6_000, files: 2, problems: [], findings: [], ...extra,
});
const hubOf = (name) => {
  const s = skills.skills.find((x) => x.name === name);
  return { current: s.current, updatedAt: s.updatedAt, pending: Boolean(s.pending) };
};
const EVERY = ["codex", "opencode", "pi", "openclaw"];

export const skillCompare = {
  [MACHINES.studio]: {
    machine: skillMachines.machines[0],
    outOfSync: 4,
    rows: [
      { name: "db-migrations", description: skills.skills[2].description, status: "same", agents: ["claude", "opencode"], hub: hubOf("db-migrations"), pc: pcSkill("db-migrations", ".claude/skills") },
      { name: "e2e-playwright", description: skills.skills[4].description, status: "hub-only", agents: [], hub: hubOf("e2e-playwright") },
      { name: "flaky-test-triage", description: "Bisect a flaky test across the last green runs and name the commit.", status: "local-only", agents: EVERY, pc: pcSkill("flaky-test-triage", ".agents/skills") },
      { name: "release-notes", description: skills.skills[1].description, status: "same", agents: EVERY, hub: hubOf("release-notes"), pc: pcSkill("release-notes", ".agents/skills") },
      { name: "review-pr", description: skills.skills[0].description, status: "same", agents: ["claude", "opencode"], hub: hubOf("review-pr"), pc: pcSkill("review-pr", ".claude/skills") },
      { name: "stripe-webhooks", description: skills.skills[3].description, status: "differs", newer: "local", agents: EVERY, hub: hubOf("stripe-webhooks"), pc: pcSkill("stripe-webhooks", ".agents/skills") },
      { name: "sql-style", description: "Acme's SQL style: CTEs over subqueries, explicit column lists.", status: "local-only", agents: ["claude", "opencode"], pc: pcSkill("sql-style", ".claude/skills") },
    ],
  },
  [MACHINES.laptop]: {
    machine: skillMachines.machines[1],
    error: "dev-laptop is offline",
    outOfSync: 0,
    rows: skills.skills.map((s) => ({ name: s.name, description: s.description, status: "unknown", agents: [], hub: hubOf(s.name) })),
  },
};
