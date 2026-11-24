#!/usr/bin/env node
/*
 * The real hub web UI (apps/hub, its own Next build) on made-up data, with no
 * relay, no boxes and no sign-in. It is what `pnpm shoot` points at, and what
 * the CLI's hub-backed commands (`agentbox ls`) can be pointed at too.
 *
 *   pnpm fixture-hub                 # http://127.0.0.1:3126
 *   PORT=3200 pnpm fixture-hub
 *   pnpm fixture-hub --dev           # next dev instead of the built .next (slow first paint)
 *
 * How it works, mirroring apps/hub/server.ts: the dashboard layout reads its
 * state from globalThis.__AGENTBOX_HUB_BACKEND.getData(), so this sets a
 * fixture backend there before Next starts; every /api/v1 request the pages
 * make is answered here from fixtures/api.mjs and never reaches the hub's own
 * routes. A request no fixture answers is logged as "unhandled": add it to
 * fixtures/api.mjs.
 *
 * It needs the hub's production build in apps/hub/.next (`pnpm --filter
 * @agentbox/hub build`, or the build:standalone the CLI uses). It never
 * touches ~/.agentbox: HOME is a scratch folder under marketing/.cache.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hubDir = resolve(root, "../apps/hub");
const dev = process.argv.includes("--dev");
const port = Number(process.env.PORT ?? 3126);
const host = "127.0.0.1";

/* Before anything of the hub's loads: auth off, localhost profile, scratch HOME. */
const home = join(root, ".cache/home");
mkdirSync(join(home, ".agentbox"), { recursive: true });
process.env.HOME = home;
process.env.AGENTBOX_HUB_AUTH = "off";
process.env.AGENTBOX_HUB_PROFILE = "localhost";
process.env.NEXT_TELEMETRY_DISABLED = "1";

const { hubState } = await import("../fixtures/acme.mjs");
const { route } = await import("../fixtures/api.mjs");

const log = (...a) => console.log("[fixture-hub]", ...a);

/* The fixture backend. Only getData is real; anything else the server side
   asks for is logged so a missing piece shows up instead of hanging. */
const backend = {
  getData: async () => structuredClone(hubState),
  /* The create modal's branch picker (a server action, not /api/v1). */
  listBranches: async () => ({ ok: true, current: "main", branches: ["main", "feat/charge-backoff", "fix/idempotency-keys", "release/2026-11"] }),
};
globalThis.__AGENTBOX_HUB_BACKEND = new Proxy(backend, {
  get(target, key) {
    if (key in target || typeof key === "symbol" || key === "then") return target[key];
    return async () => {
      log(`backend.${String(key)}() has no fixture`);
      return undefined;
    };
  },
});

if (!dev) {
  const rsf = join(hubDir, ".next/required-server-files.json");
  if (!existsSync(join(hubDir, ".next/BUILD_ID")))
    throw new Error("apps/hub has no production build: run `pnpm --filter @agentbox/hub build`, or use --dev");
  if (existsSync(rsf)) process.env.__NEXT_PRIVATE_STANDALONE_CONFIG ??= JSON.stringify(JSON.parse(readFileSync(rsf, "utf8")).config);
}
process.chdir(hubDir);
const next = createRequire(join(hubDir, "package.json"))("next");
const app = next({ dev, dir: hubDir, hostname: host, port });
await app.prepare();
const handle = app.getRequestHandler();

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  const p = url.pathname;
  if (p === "/healthz") {
    /* What the CLI's ensureHub() reads to reuse a running hub instead of
       reclaiming the port. No `pid` and no `version` on purpose: with no pid
       there is nothing to kill, and with no version any CLI build reuses it. */
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, boxes: hubState.boxes.length, events: 0, ui: true, cliEntry: true, profile: "localhost" }));
    return;
  }
  if (p === "/api/events") {
    /* Live refresh: an open stream that never fires, so a page stays as drawn. */
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": fixture\n\n");
    return;
  }
  if (p.startsWith("/api/v1/") || p.startsWith("/api/jobs/")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    const answer = route(req.method ?? "GET", p, url.searchParams, body);
    if (!answer) {
      log(`unhandled ${req.method} ${p}${url.search}`);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "no fixture for this route" } }));
      return;
    }
    const { status = 200, json, text, type } = answer;
    res.writeHead(status, { "content-type": type ?? (text != null ? "text/plain; charset=utf-8" : "application/json") });
    res.end(text ?? JSON.stringify(json));
    return;
  }
  handle(req, res);
}).listen(port, host, () => log(`ready on http://${host}:${port} (${dev ? "next dev" : "apps/hub/.next"})`));
