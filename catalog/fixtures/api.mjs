/* The hub's /api/v1 on the Acme fixtures (acme.mjs): one entry per route a
   page or the CLI reads. `route()` returns { json } / { text } / { status }, or
   nothing when no fixture matches (scripts/fixture-hub.mjs logs those).
   Writes (POST/PATCH/DELETE) answer ok without changing anything, so a click
   in a screenshot session never fails loudly. */
import { NOW } from "./acme.mjs";
import { dataFor } from "./scenarios.mjs";
/* The usage stats run packages/usage-view's aggregation from its dist. Loaded
   apart, so an unbuilt usage-view fails only the routes that need it. */
let usageLib = null;
let usageViewError = null;
try {
  usageLib = { ...(await import("./activity.mjs")), ...(await import("../../packages/usage-view/dist/index.js")) };
} catch (e) {
  usageViewError = `usage fixtures unavailable (build packages/usage-view): ${e.message}`;
  console.warn(`[fixtures] ${usageViewError}`);
}
/* A scenario's ledger and stats (activity.mjs), made once per data set. */
const usageViews = new WeakMap();
const usageOf = (d) => {
  if (!usageLib) return null;
  if (!usageViews.has(d)) usageViews.set(d, { ...usageLib, ...usageLib.makeActivity(d, d.scale) });
  return usageViews.get(d);
};
const needUsage = (fn) => (m, q, d) => (usageOf(d) ? fn(m, q, d, usageOf(d)) : { __status: 503, __message: usageViewError });
const allUsageRows = (d) => (usageOf(d) ? usageOf(d).tokenRows() : d.usageRows);

const GET = [
  [/^\/api\/v1\/health$/, (_, q, d) => ({ ok: true, apiVersion: "v1", version: d.system.hub.version, profile: d.system.hub.profile })],
  [/^\/api\/v1\/boxes$/, (_, q, d) => ({ boxes: d.boxes })],
  [/^\/api\/v1\/boxes\/([^/]+)$/, ([id], q, d) => box(d, id)],
  [/^\/api\/v1\/boxes\/([^/]+)\/git$/, ([id], q, d) => withBox(d, id, d.boxGit)],
  [/^\/api\/v1\/boxes\/([^/]+)\/services$/, ([id], q, d) => withBox(d, id, d.boxServices)],
  [/^\/api\/v1\/boxes\/([^/]+)\/skills$/, ([id], q, d) => withBox(d, id, d.boxSkills)],
  [/^\/api\/v1\/open-targets$/, (_, q, d) => d.openTargets],
  [/^\/api\/v1\/projects$/, (_, q, d) => ({ projects: d.hubState.projects })],
  [/^\/api\/v1\/projects\/([^/]+)\/seed$/, ([id], q, d) => ({ custodyAvailable: true, seed: d.seeds[decodeURIComponent(id)] ?? null })],
  [/^\/api\/v1\/projects\/([^/]+)\/bots$/, ([id], q, d) => ({ bots: d.bots[decodeURIComponent(id)] ?? [] })],
  [/^\/api\/v1\/workspaces$/, (_, q, d) => ({ workspaces: d.workspaces })],
  [/^\/api\/v1\/approvals$/, (_, q, d) => ({ approvals: d.approvals })],
  [/^\/api\/v1\/providers$/, (_, q, d) => ({ providers: d.providers })],
  [/^\/api\/v1\/accounts$/, (_, q, d) => d.accounts],
  [/^\/api\/v1\/accounts\/policy$/, () => ({ onLimit: "ask" })],
  [/^\/api\/v1\/agents$/, () => ({
    agents: [
      { id: "claude", label: "Claude", installed: true },
      { id: "codex", label: "Codex", installed: true },
      { id: "opencode", label: "OpenCode", installed: true },
      { id: "pi", label: "Pi", installed: false },
      { id: "openclaw", label: "OpenClaw", installed: false },
    ],
  })],
  [/^\/api\/v1\/skills$/, (_, q, d) => d.skills],
  [/^\/api\/v1\/skills\/([^/]+)\/diff$/, ([name], q, d) => skillDiff(d, decodeURIComponent(name), q)],
  [/^\/api\/v1\/skills\/([^/]+)\/skill-md$/, ([name], q, d) => readSkillMd(d, decodeURIComponent(name))],
  [/^\/api\/v1\/skill-status$/, (_, q, d) => d.skillStatus],
  [/^\/api\/v1\/skill-machines$/, (_, q, d) => d.skillMachines],
  [/^\/api\/v1\/skill-machines\/([^/]+)\/compare$/, ([id], q, d) => d.skillCompare[decodeURIComponent(id)] ?? { __status: 404 }],
  [/^\/api\/v1\/skill-bindings$/, (_, q, d) => bindings(d, q)],
  [/^\/api\/v1\/skill-bindings\/resolve$/, (_, q, d) => resolveBindings(d, q)],
  [/^\/api\/v1\/system$/, (_, q, d) => d.system],
  [/^\/api\/v1\/custody$/, (_, q, d) => ({ ...d.custody, entries: d.custody.entries.filter((e) => !q.get("prefix") || `${e.path}/`.startsWith(`${q.get("prefix")}/`)) })],
  [/^\/api\/v1\/usage$/, (_, q, d) => usage(d, q)],
  [/^\/api\/v1\/usage\/stats$/, needUsage((_, q, d, u) => u.usageStats(u.usageStatsQuery(Object.fromEntries(q))))],
  [/^\/api\/v1\/usage\/share$/, () => ({ endpoint: SHARE_ENDPOINT, shares: SHARES, lastName: "acme-commerce" })],
  [/^\/api\/v1\/activity$/, needUsage((_, q, d, u) => u.activity(q))],
  [/^\/api\/v1\/skill-skips$/, (_, q, d) => ({ skipped: d.skillSkips })],
  [/^\/api\/v1\/accounts\/default$/, (_, q, d) => ({ defaults: Object.fromEntries(d.accounts.accounts.filter((a) => a.default?.global).map((a) => [a.agent, { account: a.id, source: "global", global: a.id }])) })],
  [/^\/api\/v1\/devices$/, (_, q, d) => d.devices],
  [/^\/api\/v1\/devices\/pending$/, (_, q, d) => d.pendingDevices],
];

function box(d, id) {
  const b = d.boxes.find((x) => x.id === decodeURIComponent(id) || x.name === decodeURIComponent(id));
  return b ? b : { __status: 404 };
}

function withBox(d, id, fn) {
  const b = box(d, id);
  return b.__status ? b : fn(b);
}

function bindings(d, q) {
  const skillBindings = d.skillBindings;
  const scope = q.get("scope");
  if (!scope) return skillBindings;
  const scopeId = q.get("scopeId") || undefined;
  const map = scope === "global" ? skillBindings.global : (skillBindings[scope]?.[scopeId] ?? {});
  return { scope, ...(scopeId ? { scopeId } : {}), bindings: map };
}

function resolveBindings(d, q) {
  const repo = q.get("repo");
  const projectKey = q.get("projectKey") || (repo ? repo.replace(/^git@([^:]+):/, "$1/").replace(/^https?:\/\//, "").replace(/\.git$/, "") : undefined);
  const set = d.resolveSkills({ boxId: q.get("boxId") || undefined, projectKey, workspaceId: q.get("workspaceId") || undefined });
  return { library: true, ...(projectKey ? { projectKey } : {}), skills: set };
}

function skillDiff(d, name, q) {
  const s = d.skills.skills.find((x) => x.name === name);
  const diff = d.skillDiffs[name];
  if (!s || !diff) return { __status: 404 };
  return { name, from: q.get("from") || s.current, to: q.get("to") || s.pending?.version, files: diff.files, findings: diff.findings };
}

function readSkillMd(d, name) {
  const s = d.skills.skills.find((x) => x.name === name);
  if (!s) return { __status: 404 };
  const content = d.skillMd[name] ?? `---\nname: ${name}\ndescription: ${s.description}\n---\n\n# ${name}\n`;
  return { name, version: s.current, content, files: [{ path: "SKILL.md", size: content.length, mode: 0o644 }] };
}

/* GET /api/v1/usage over usageRows: the route's filters, window and grouping. */
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const DIM = {
  agent: (r) => r.agent,
  account: (r) => r.account,
  box: (r) => r.box,
  project: (r) => r.project,
  host: (r) => r.host,
  model: (r) => r.model,
  session: (r) => r.session,
};
const LABEL = { box: (r) => r.boxName, project: (r) => r.projectUrl, session: (r) => r.title };

function usage(d, q) {
  const time = (raw) => {
    const rel = /^(\d+)([mhdw])$/.exec(raw);
    return rel ? NOW - Number(rel[1]) * UNIT_MS[rel[2]] : Date.parse(raw);
  };
  const since = q.get("since") ? time(q.get("since")) : -Infinity;
  const until = q.get("until") ? time(q.get("until")) : Infinity;
  const tz = Number(q.get("tzOffset") || 0) * 60_000;
  const by = (q.get("by") || "").split(",").map((d) => d.trim()).filter(Boolean);
  const limit = Number(q.get("limit") || 200);
  const keyOf = (d, r) => (d === "day" ? new Date(r.at + tz).toISOString().slice(0, 10) : DIM[d](r));
  const rows = allUsageRows(d).filter((r) => {
    if (r.at < since || r.at >= until) return false;
    if (q.get("box") && r.box !== q.get("box") && r.boxName !== q.get("box")) return false;
    if (q.get("project") && !r.project.includes(q.get("project")) && !r.projectUrl.includes(q.get("project"))) return false;
    return ["agent", "account", "host", "model"].every((k) => !q.get(k) || r[k] === q.get(k));
  });
  const sum = (list) => {
    const t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 0 };
    for (const r of list) for (const k of Object.keys(t)) t[k] += r[k];
    return { ...t, totalTokens: t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens, sessions: new Set(list.map((r) => r.session)).size };
  };
  const totals = sum(rows);
  if (by.length === 0) return { totals, groups: [], truncated: false };
  const buckets = new Map();
  for (const r of rows) {
    const id = JSON.stringify(by.map((d) => keyOf(d, r)));
    buckets.set(id, [...(buckets.get(id) ?? []), r]);
  }
  let groups = [...buckets.values()].map((list) => ({
    keys: Object.fromEntries(by.map((d) => [d, keyOf(d, list[0])])),
    labels: Object.fromEntries(by.filter((d) => LABEL[d]).map((d) => [d, LABEL[d](list[0])])),
    ...sum(list),
  }));
  const dayDim = by.includes("day");
  groups.sort((a, b) => (dayDim && a.keys.day !== b.keys.day ? (a.keys.day < b.keys.day ? 1 : -1) : b.totalTokens - a.totalTokens));
  const truncated = groups.length > limit;
  groups = groups.slice(0, limit);
  if (dayDim) groups.sort((a, b) => a.keys.day.localeCompare(b.keys.day));
  return { totals, groups, truncated };
}

/* The usage share. Nothing is ever posted: the POST answers here, a preview
   with the share the hub would send, a "share" with a made-up link. */
const SHARE_ENDPOINT = "https://agent-box.sh/api/share";
const SHARES = [{ endpoint: SHARE_ENDPOINT, origin: "https://agent-box.sh", id: "q4Xb7Lm2", url: "https://agent-box.sh/s/q4Xb7Lm2", createdAt: new Date(NOW - 6 * 86_400_000).toISOString() }];
function share(d, body) {
  const usageView = usageOf(d);
  if (!usageView) return { status: 503, json: { error: { code: "backend_unavailable", message: usageViewError } } };
  let b = {};
  try {
    b = JSON.parse(body || "{}");
  } catch {
    return { status: 400, json: { error: { code: "invalid_request", message: "body must be JSON" } } };
  }
  if (typeof b !== "object" || b === null || Array.isArray(b))
    return { status: 400, json: { error: { code: "invalid_request", message: "body must be a JSON object" } } };
  const q = usageView.usageStatsQuery({ since: b.since, until: b.until, tz: b.tz, range: b.range, subscription: b.subscription });
  const shared = usageView.toShare(usageView.usageStats(q), typeof b.name === "string" && b.name ? b.name : undefined);
  if (b.preview === true) return { json: { share: shared, endpoint: SHARE_ENDPOINT, bytes: Buffer.byteLength(JSON.stringify(shared)) } };
  return { status: 201, json: { url: "https://agent-box.sh/s/Z8kP3nQa", id: "Z8kP3nQa", createdAt: new Date(NOW).toISOString() } };
}

/* `scenario`: which data set answers (fixtures/scenarios.mjs), default full. */
export function route(method, path, query, body, scenario = "full") {
  const d = dataFor(scenario);
  if (method === "POST" && path === "/api/v1/usage/share") return share(d, body);
  if (method !== "GET") return { json: { ok: true } };
  for (const [re, fn] of GET) {
    const m = re.exec(path);
    if (!m) continue;
    const json = fn(m.slice(1), query, d);
    if (json && json.__status === 503) return { status: 503, json: { error: { code: "backend_unavailable", message: json.__message } } };
    if (json && json.__status) return { status: json.__status, json: { error: { code: "not_found", message: "not found" } } };
    return { json };
  }
  return null;
}

export { dataFor, SCENARIOS } from "./scenarios.mjs";
