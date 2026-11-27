#!/usr/bin/env node
/*
 * Takes a screenshot of one hub page, served by the fixture hub
 * (scripts/fixture-hub.mjs: the real apps/hub UI on the Acme demo data), into
 * shots/.
 *
 *   pnpm shoot <file under shots/> <hub path> [options] [steps]
 *
 *   pnpm shoot hub/boxes.png /
 *   pnpm shoot hub/skills-update.png /skills --click "text=Review update"
 *   pnpm shoot hub/box-detail.png /boxes/7f3a9c21b8d4 --full
 *
 * Every page opens with the clock pinned to the fixtures' NOW, animations off,
 * light theme (unless --dark), en-US, UTC. Start the fixture hub first (`pnpm fixture-hub`).
 *
 * Options
 *   --size <WxH>       viewport in CSS pixels (default 1440x900)
 *   --scale <n>        pixel density (default 2)
 *   --full             grow the window until the page's whole height fits
 *   --el <selector>    capture one element, not the window
 *   --dark             dark theme (the hub follows the OS scheme when no theme is saved)
 *   --storage <k>=<v>  a localStorage entry set before the page loads, e.g.
 *                      hub-sidebar=collapsed for the collapsed rail (repeatable)
 *   --base <url>       the fixture hub (default $HUB_FIXTURE_URL or http://127.0.0.1:3126)
 *
 * Steps run in the order given, after the page loads. Selectors are Playwright's.
 *   --click <sel>  --hover <sel>  --fill <sel>=<value>  --wait-for <sel>
 *   --scroll-to <sel>  --hide <sel>  --wait <ms>
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { NOW } from "../fixtures/acme.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const STEP_FLAGS = {
  "--click": "click",
  "--hover": "hover",
  "--fill": "fill",
  "--wait-for": "waitFor",
  "--scroll-to": "scrollTo",
  "--hide": "hide",
  "--wait": "wait",
};
const args = process.argv.slice(2);
const opts = { size: "1440x900", scale: 2, base: process.env.HUB_FIXTURE_URL ?? "http://127.0.0.1:3126" };
const steps = [];
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a in STEP_FLAGS) {
    const value = args[++i];
    const action = STEP_FLAGS[a];
    if (action === "wait") steps.push({ action, ms: Number(value) });
    else if (action === "fill")
      steps.push({ action, target: value.slice(0, value.indexOf("=")), value: value.slice(value.indexOf("=") + 1) });
    else steps.push({ action, target: value });
  } else if (a === "--full") opts.full = true;
  else if (a === "--dark") opts.dark = true;
  else if (a === "--storage") (opts.storage ??= []).push(args[++i]);
  else if (["--size", "--scale", "--el", "--base"].includes(a)) opts[a.slice(2)] = args[++i];
  else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
  else rest.push(a);
}
const [file, path] = rest;
if (!file || !path?.startsWith("/")) {
  console.error("Usage: pnpm shoot <file under shots/> </hub/path> [options] [steps]   (the header of scripts/shoot.mjs lists them)");
  process.exit(1);
}

async function run(page, step) {
  const el = step.target ? page.locator(step.target).first() : null;
  if (step.action === "click") return el.click();
  if (step.action === "hover") return el.hover();
  if (step.action === "fill") return el.fill(step.value);
  if (step.action === "waitFor") return el.waitFor({ state: "visible" });
  /* The hub's top bar is sticky: leave room for it above the element. */
  if (step.action === "scrollTo")
    return el.evaluate((node) => window.scrollTo(0, node.getBoundingClientRect().top + window.scrollY - 80));
  if (step.action === "hide")
    return page.locator(step.target).evaluateAll((nodes) => nodes.forEach((node) => (node.style.display = "none")));
  return page.waitForTimeout(step.ms);
}

const [width, height] = opts.size.split("x").map(Number);
const url = opts.base.replace(/\/$/, "") + path;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: Number(opts.scale),
    colorScheme: opts.dark ? "dark" : "light",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });
  await context.clock.setFixedTime(new Date(NOW));
  if (opts.storage) {
    const entries = opts.storage.map((kv) => {
      const at = kv.indexOf("=");
      if (at < 1) throw new Error(`--storage wants <key>=<value>, got "${kv}"`);
      return [kv.slice(0, at), kv.slice(at + 1)];
    });
    await context.addInitScript((list) => {
      for (const [k, v] of list) localStorage.setItem(k, v);
    }, entries);
  }
  const page = await context.newPage();
  const missing = [];
  page.on("response", (r) => {
    if (r.status() === 404 && new URL(r.url()).pathname.startsWith("/api/")) missing.push(new URL(r.url()).pathname);
  });
  /* "Settled" = no request in flight for 500ms, the live-refresh stream
     (/api/events, never closes) left out. Playwright's networkidle would wait on it forever. */
  const inflight = new Set();
  const track = (r) => !r.url().includes("/api/events") && inflight.add(r);
  page.on("request", track);
  page.on("requestfinished", (r) => inflight.delete(r));
  page.on("requestfailed", (r) => inflight.delete(r));
  const settle = async () => {
    for (let quiet = 0, t = 0; quiet < 5 && t < 200; t++) {
      await page.waitForTimeout(100);
      quiet = inflight.size === 0 ? quiet + 1 : 0;
    }
  };
  const response = await page.goto(url, { waitUntil: "load", timeout: 120_000 });
  if (response && !response.ok()) throw new Error(`${url} answered ${response.status()}`);
  await settle();
  await page.evaluate(() => document.fonts.ready);
  for (const step of steps) {
    await run(page, step);
    await settle();
  }
  await page.waitForTimeout(300);

  if (opts.full) {
    const extra = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    if (extra > 0) await page.setViewportSize({ width, height: Math.min(height + extra, 8000) });
    await page.waitForTimeout(400);
  }

  const out = join(root, "shots", file);
  mkdirSync(dirname(out), { recursive: true });
  const shot = { path: out, animations: "disabled", caret: "hide" };
  if (opts.el) await page.locator(opts.el).first().screenshot(shot);
  else await page.screenshot(shot);
  console.log(`shots/${file}  ←  ${url}`);
  for (const p of new Set(missing)) console.warn(`  ! ${p} answered 404: add a fixture in fixtures/api.mjs`);
} finally {
  await browser.close();
}
