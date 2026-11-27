#!/usr/bin/env node
/*
 * Takes a screenshot of the macOS tray app (../agentbox-tray) in its fixture
 * mode: the same Acme demo data as the hub fixtures, no hub, no shell-outs.
 *
 *   pnpm shoot:tray <file under shots/> [--press <ax id>]... [options]
 *
 *   pnpm shoot:tray tray/menu.png
 *   pnpm shoot:tray tray/skill-updates.png --press agentbox.environment
 *   pnpm shoot:tray tray/box-skills-behind.png --press agentbox.box.queue-retries
 *   pnpm shoot:tray tray/skill-approve-confirm.png --press agentbox.environment --press agentbox.skillUpdates.review-pr --alert
 *   pnpm shoot:tray tray/manager.png --manager fx-commerce
 *
 * What it drives: a SECOND tray instance, AgentBoxE2E.app (`make e2e-app` in
 * ../agentbox-tray; own bundle id and process name, so the owner's real tray
 * is never touched), launched with --fixtures, and the AX driver in
 * e2e/tray-driver (`swift build -c release` there). Ids are the tray's
 * accessibility identifiers: `e2e/tray-driver ... tree --pid <pid>` lists them.
 *
 * The capture is `screencapture -l <window id>` of the app's own windows only,
 * never a screen region: a region would pick up whatever else is on the
 * owner's screen. A menu and its open submenus come out as one picture with a
 * transparent background. The translucent material of menus and alerts would
 * come out over black (dark gray), so scripts/backdrop.mjs redraws it over a
 * light desktop.
 *
 * Opening a menu takes the screen for a moment, so this waits until the Mac
 * has been idle for --idle seconds (default 3).
 *
 * Options
 *   --press <id>      AXPress an item after the menu opens (repeat, in order)
 *   --alert           the last press opens an alert: capture it, then quit the
 *                     fixture app (the alert is modal; a relaunch resets the demo)
 *   --manager <ws>    capture the Manager window on that fixture workspace instead of the menu
 *   --idle <s>        seconds of no input to wait for first (default 3)
 *   --restart         quit and relaunch the fixture app first (resets its demo state)
 *   --scenario <name> the tray's fixture data set, passed to the app as
 *                     --fixtures-scenario <name> (the names in fixtures/scenarios.mjs).
 *                     The app is relaunched when the scenario changes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "../fixtures/scenarios.mjs";
import { addBackdrop } from "./backdrop.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "..");
const APP = resolve(process.env.TRAY_APP ?? join(repo, "../agentbox-tray/AgentBoxE2E.app"));
const PROC = "AgentBoxE2E";
const DRIVER = join(repo, "e2e/tray-driver/.build/release/tray-driver");

const args = process.argv.slice(2);
const opts = { press: [], idle: 3 };
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--press") opts.press.push(args[++i]);
  else if (a === "--manager") opts.manager = args[++i];
  else if (a === "--idle") opts.idle = Number(args[++i]);
  else if (a === "--scenario") opts.scenario = args[++i];
  else if (["--alert", "--restart"].includes(a)) opts[a.slice(2)] = true;
  else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
  else rest.push(a);
}
const [file] = rest;
if (!file) {
  console.error("Usage: pnpm shoot:tray <file under shots/> [--press <ax id>]... (the header of scripts/shoot-tray.mjs lists the options)");
  process.exit(1);
}
if (opts.scenario && !SCENARIOS[opts.scenario]) throw new Error(`unknown scenario "${opts.scenario}": ${Object.keys(SCENARIOS).join(", ")}`);
for (const [path, how] of [[APP, "cd ../agentbox-tray && make e2e-app"], [DRIVER, "cd e2e/tray-driver && swift build -c release"]])
  if (!existsSync(path)) throw new Error(`${path} is missing: ${how}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const driver = (...a) => {
  const r = spawnSync(DRIVER, a, { encoding: "utf8" });
  const out = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
  if (!out.ok) throw new Error(`tray-driver ${a.join(" ")}: ${out.error ?? r.stderr}`);
  return out;
};
const pidOf = () => {
  const r = spawnSync("pgrep", ["-x", PROC], { encoding: "utf8" });
  return Number(r.stdout.trim().split("\n")[0]) || null;
};

/* The app's on-screen windows, through CoreGraphics (JXA: no extra tooling). */
const WINLIST = `ObjC.import('CoreGraphics');
function run(argv) {
  const pid = Number(argv[0]);
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0));
  const out = [];
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i);
    if (Number(ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID'))) !== pid) continue;
    const b = w.objectForKey('kCGWindowBounds');
    const n = (k) => Number(ObjC.unwrap(b.objectForKey(k)));
    out.push({ id: Number(ObjC.unwrap(w.objectForKey('kCGWindowNumber'))), layer: Number(ObjC.unwrap(w.objectForKey('kCGWindowLayer'))),
      title: String(ObjC.unwrap(w.objectForKey('kCGWindowName')) ?? ''), x: n('X'), y: n('Y'), w: n('Width'), h: n('Height') });
  }
  return JSON.stringify(out);
}`;
const work = mkdtempSync(join(tmpdir(), "shoot-tray-"));
writeFileSync(join(work, "winlist.js"), WINLIST);
const windows = (pid) => JSON.parse(execFileSync("osascript", ["-l", "JavaScript", join(work, "winlist.js"), String(pid)], { encoding: "utf8" }));
const STATUS_LAYER = 25;

const capture = (id, out) => {
  const r = spawnSync("/usr/sbin/screencapture", ["-x", "-o", "-l", String(id), out]);
  if (r.status !== 0 || !existsSync(out)) throw new Error(`screencapture -l ${id} failed (Screen Recording permission?)`);
};

/* The running fixture app's scenario: an instance from another --scenario run
   would answer with the wrong data, so it is relaunched. */
const STAMP = join(tmpdir(), "agentbox-shoot-tray-scenario");
const scenarioArgs = opts.scenario ? ["--fixtures-scenario", opts.scenario] : [];
async function launch(extra = []) {
  spawnSync("open", ["-n", APP, "--args", "--fixtures", ...scenarioArgs, ...extra]);
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const pid = pidOf();
    if (pid && spawnSync(DRIVER, ["find", "--pid", String(pid), "--id", "agentbox.statusItem", "--timeout", "0.5"]).status === 0) {
      writeFileSync(STAMP, opts.scenario ?? "full");
      return pid;
    }
  }
  throw new Error(`${PROC} did not show its status item`);
}
async function quit() {
  spawnSync("pkill", ["-x", PROC]);
  rmSync(STAMP, { force: true });
  for (let i = 0; i < 25 && pidOf(); i++) await sleep(200);
}

async function waitIdle() {
  for (let waited = 0; ; waited++) {
    const f = driver("frontmost");
    if (f.screenLocked) throw new Error("the screen is locked: AX cannot open a menu");
    if (f.idleSeconds >= opts.idle) return;
    if (waited === 0) console.log(`waiting for ${opts.idle}s without input...`);
    await sleep(1000);
  }
}

const out = join(root, "shots", file);
mkdirSync(dirname(out), { recursive: true });

const running = existsSync(STAMP) ? readFileSync(STAMP, "utf8") : "full";
if (opts.restart || opts.manager || (pidOf() && running !== (opts.scenario ?? "full"))) await quit();
let pid = pidOf() ?? (await launch(opts.manager ? ["--open-manager", opts.manager] : []));

try {
  if (opts.manager) {
    let win;
    for (let i = 0; i < 40 && !win; i++) {
      await sleep(250);
      win = windows(pid).find((w) => w.layer === 0 && w.w > 400 && w.h > 300);
    }
    if (!win) throw new Error("the Manager window did not open");
    await sleep(1500); // the timeline and the terminal paint after the window appears
    capture(win.id, out);
  } else {
    await waitIdle();
    driver("open-menu", "--pid", String(pid));
    for (const id of opts.press) {
      driver("press", "--pid", String(pid), "--id", id);
      await sleep(700);
    }
    await sleep(300);
    const wins = windows(pid).filter((w) => w.layer !== STATUS_LAYER && w.w > 30 && w.h > 30);
    if (!wins.length)
      throw new Error(`no ${opts.alert ? "alert" : "menu"} window on screen: it closed before the capture (was the Mac in use?). shots/${file} was not updated`);
    if (opts.alert) {
      const alert = wins.find((w) => w.layer === 0) ?? wins.at(-1);
      capture(alert.id, out);
      addBackdrop(out);
    } else {
      /* Capturing one menu window gives that menu with its open parents/children
         composited; keep the largest of the pictures to be sure every level is in. */
      let best = 0;
      for (const w of wins) {
        const f = join(work, `${w.id}.png`);
        capture(w.id, f);
        if (statSync(f).size > best) {
          best = statSync(f).size;
          copyFileSync(f, out);
        }
      }
      addBackdrop(out);
    }
  }
  console.log(`shots/${file}  ←  ${PROC} --fixtures${opts.scenario ? ` --fixtures-scenario ${opts.scenario}` : ""}${opts.press.length ? " · " + opts.press.join(" → ") : ""}`);
} finally {
  if (opts.alert) await quit();
  else if (!opts.manager && pidOf()) {
    try {
      driver("close-menu", "--pid", String(pidOf()));
    } catch {}
  }
  if (opts.manager) await quit();
}
