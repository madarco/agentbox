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
 *   pnpm shoot:tray tray/setup-project.png --setup project
 *   pnpm shoot:tray tray/setup-menu-tip.png --menu-tip
 *   pnpm shoot:tray tray/new-box.png --restart --press agentbox.header.newBox --select agentbox.create.project ios-app --window
 *
 * What it drives: a SECOND tray instance, AgentBoxE2E.app (`make e2e-app` in
 * ../agentbox-tray; own bundle id and process name, so the owner's real tray
 * is never touched), launched with --fixtures, and the AX driver in
 * e2e/tray-driver (`swift build -c release` there). Ids are the tray's
 * accessibility identifiers: `e2e/tray-driver ... tree --pid <pid>` lists them.
 * The app is started by exec, and only the pid this script started is ever
 * driven or quit, never another AgentBoxE2E by name.
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
 *   --select <id> <title>  after the presses, pick the item titled <title> in the pop-up button
 *                     <id> (repeat, in order): a project in the New Box card
 *   --window          the last press opens a window (the New Box card): capture it, then quit
 *   --manager <ws>    capture the Manager window on that fixture workspace instead of the menu
 *   --settings <page> capture the Settings window on that page (general, subscriptions, skills,
 *                     providers) instead of the menu; the app opens it at launch (--open-settings)
 *   --setup <step>    capture the setup wizard (the app's --setup) on a step: welcome, provider,
 *                     project (the demo project picked) or project-folder (one of your folders).
 *                     Its buttons are pressed through System Events, and Open at Login is
 *                     switched off before Get started: Get started registers the bundle being run
 *                     as a login item, and the fixture app must never become one
 *   --menu-tip        capture the menu the wizard drops down when it hands off, with the floating
 *                     "Start a box here" tip beside it (the app's --menu-tip), as one picture
 *   --idle <s>        seconds of no input to wait for first (default 3)
 *   --restart         quit and relaunch the fixture app first (resets its demo state)
 *   --scenario <name> the tray's fixture data set, passed to the app as
 *                     --fixtures-scenario <name> (the names in fixtures/scenarios.mjs).
 *                     The app is relaunched when the scenario changes.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "../fixtures/scenarios.mjs";
import { addBackdrop, readPng, writePng } from "./backdrop.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "..");
const APP = resolve(process.env.TRAY_APP ?? join(repo, "../agentbox-tray/AgentBoxE2E.app"));
const PROC = "AgentBoxE2E";
const BIN = join(APP, "Contents/MacOS", PROC);
const DRIVER = join(repo, "e2e/tray-driver/.build/release/tray-driver");

const args = process.argv.slice(2);
const opts = { press: [], select: [], idle: 3 };
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--press") opts.press.push(args[++i]);
  else if (a === "--select") opts.select.push([args[++i], args[++i]]);
  else if (a === "--manager") opts.manager = args[++i];
  else if (a === "--settings") opts.settings = args[++i];
  else if (a === "--setup") opts.setup = args[++i];
  else if (a === "--menu-tip") opts.menuTip = true;
  else if (a === "--idle") opts.idle = Number(args[++i]);
  else if (a === "--scenario") opts.scenario = args[++i];
  else if (["--alert", "--restart", "--window"].includes(a)) opts[a.slice(2)] = true;
  else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
  else rest.push(a);
}
const [file] = rest;
if (!file) {
  console.error("Usage: pnpm shoot:tray <file under shots/> [--press <ax id>]... (the header of scripts/shoot-tray.mjs lists the options)");
  process.exit(1);
}
const SETUP_STEPS = ["welcome", "provider", "project", "project-folder"];
if (opts.setup && !SETUP_STEPS.includes(opts.setup)) throw new Error(`unknown setup step "${opts.setup}": ${SETUP_STEPS.join(", ")}`);
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

/* The fixture app this script launched, kept between runs: its pid and scenario. */
const STAMP = join(tmpdir(), "agentbox-shoot-tray.json");
const stamp = () => {
  try {
    return JSON.parse(readFileSync(STAMP, "utf8"));
  } catch {
    return null;
  }
};
const pidOf = () => {
  const pid = stamp()?.pid;
  if (!pid) return null;
  const r = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
  return r.stdout.trim().endsWith(`/${PROC}`) ? pid : null;
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

/* Launched by exec, not `open` (which drops the environment): the What's New card, the
   wizard's first-launch open, the Manager tour and the notification prompt stay off, and the
   appearance is pinned to light whatever the Mac uses. An instance from another --scenario
   run would answer with the wrong data, so it is relaunched. */
const scenarioArgs = opts.scenario ? ["--fixtures-scenario", opts.scenario] : [];
const QUIET = ["-SetupWizardSeen", "YES", "-ManagerTourSeen", "YES", "-LastSeenWhatsNewVersion", "999.0.0"];
async function launch(extra = []) {
  const child = spawn(BIN, ["--fixtures", ...scenarioArgs, "--appearance", "light", ...extra, ...QUIET], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, AGENTBOX_TRAY_NO_NOTIFICATIONS: "1" },
  });
  child.unref();
  writeFileSync(STAMP, JSON.stringify({ pid: child.pid, scenario: opts.scenario ?? "full" }));
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const pid = pidOf();
    if (pid && spawnSync(DRIVER, ["find", "--pid", String(pid), "--id", "agentbox.statusItem", "--timeout", "0.5"]).status === 0) return pid;
  }
  throw new Error(`${PROC} did not show its status item`);
}
async function quit() {
  const pid = pidOf();
  if (pid) process.kill(pid, "SIGTERM");
  for (let i = 0; i < 25 && pidOf(); i++) await sleep(200);
  rmSync(STAMP, { force: true });
}

async function waitIdle() {
  for (let waited = 0; ; waited++) {
    const f = driver("frontmost");
    if (f.screenLocked) {
      if (waited === 0) console.log("the screen is locked: waiting for it to unlock...");
    } else if (f.idleSeconds >= opts.idle) return;
    else if (waited === 0) console.log(`waiting for ${opts.idle}s without input...`);
    await sleep(1000);
  }
}

const waitFor = async (check, what, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const v = check();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`${what} did not show`);
};

/* System Events on our pid: the setup wizard's buttons have titles, not AX ids. */
const ui = (pid, ...lines) => {
  const script = [`tell application "System Events" to tell (first process whose unix id is ${pid})`, ...lines, "end tell"];
  const r = spawnSync("osascript", script.flatMap((l) => ["-e", l]), { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`System Events: ${r.stderr.trim()}`);
  return r.stdout.trim();
};
const SETUP = 'window "AgentBox Setup"';
async function walkSetup(pid, step) {
  const n = SETUP_STEPS.indexOf(step);
  await waitFor(() => ui(pid, `exists button "Get started" of ${SETUP}`) === "true", "the setup wizard");
  // The System check fills in, then Get started enables.
  await waitFor(() => ui(pid, `enabled of button "Get started" of ${SETUP}`) === "true", "an enabled Get started");
  if (n >= 1) {
    ui(
      pid,
      `set s to first button of scroll area 1 of ${SETUP} whose subrole is "AXSwitch"`,
      "if value of s is 1 then click s",
      "delay 0.3",
      'if value of s is not 0 then error "Open at Login is still on"',
      `click button "Get started" of ${SETUP}`,
    );
    await waitFor(() => ui(pid, `exists button "Continue" of ${SETUP}`) === "true", "the Provider step");
  }
  if (n >= 2) {
    ui(pid, `click button "Continue" of ${SETUP}`);
    await waitFor(() => ui(pid, `exists button "Start Manager" of ${SETUP}`) === "true", "the Project step");
  }
  if (n >= 3) ui(pid, `click (first radio button of scroll area 1 of ${SETUP} whose description is "Choose folder")`);
}

/* Windows captured one by one, put back together at their screen positions on a transparent
   canvas (the menu and the tip beside it are two windows). layers: [{ file, x, y, w, h }] in
   points, the first one underneath. */
function composite(out, layers) {
  const imgs = layers.map((l) => readPng(l.file));
  const scale = imgs[0].w / layers[0].w;
  const x0 = Math.min(...layers.map((l) => l.x));
  const y0 = Math.min(...layers.map((l) => l.y));
  const W = Math.round((Math.max(...layers.map((l) => l.x + l.w)) - x0) * scale);
  const H = Math.round((Math.max(...layers.map((l) => l.y + l.h)) - y0) * scale);
  const px = Buffer.alloc(W * H * 4);
  layers.forEach((l, k) => {
    const img = imgs[k];
    const ox = Math.round((l.x - x0) * scale);
    const oy = Math.round((l.y - y0) * scale);
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) {
        const dx = ox + x;
        const dy = oy + y;
        if (dx >= W || dy >= H) continue;
        const s = (y * img.w + x) * 4;
        const d = (dy * W + dx) * 4;
        const sa = img.px[s + 3] / 255;
        const da = px[d + 3] / 255;
        const a = sa + da * (1 - sa);
        if (a === 0) continue;
        for (let c = 0; c < 3; c++) px[d + c] = Math.round((img.px[s + c] * sa + px[d + c] * da * (1 - sa)) / a);
        px[d + 3] = Math.round(a * 255);
      }
    }
  });
  const chunks = imgs[0].chunks.map((c) => {
    if (c.type !== "IHDR") return c;
    const data = Buffer.from(c.data);
    data.writeUInt32BE(W, 0);
    data.writeUInt32BE(H, 4);
    return { type: c.type, data };
  });
  writePng(out, { w: W, h: H, px, chunks });
}

const out = join(root, "shots", file);
mkdirSync(dirname(out), { recursive: true });

const running = stamp()?.scenario ?? "full";
/* A window (or the hand-off menu) the app opens itself at launch, captured instead of the menu. */
const windowArgs = opts.manager
  ? ["--open-manager", opts.manager]
  : opts.settings
    ? ["--open-settings", opts.settings]
    : opts.setup
      ? ["--setup"]
      : opts.menuTip
        ? ["--menu-tip"]
        : null;
if (opts.restart || windowArgs || (pidOf() && running !== (opts.scenario ?? "full"))) await quit();
/* --menu-tip drops the menu down on its own ~1.5s after launch. */
if (opts.menuTip) await waitIdle();
let pid = pidOf() ?? (await launch(windowArgs ?? []));
/* A modal alert, the New Box card, the wizard and the hand-off menu leave the demo in a state
   the next shot should not start from. */
const quitAfter = opts.alert || opts.window || opts.manager || opts.setup || opts.menuTip;

try {
  if (opts.setup) {
    await walkSetup(pid, opts.setup);
    await sleep(1000); // the step's cards and the bake band settle
    const mine = windows(pid);
    const win = mine.find((w) => w.layer === 0 && w.title === "AgentBox Setup") ?? mine.find((w) => w.layer === 0 && w.w > 400);
    if (!win) throw new Error("the setup window is not on screen");
    capture(win.id, out);
  } else if (opts.menuTip) {
    /* The tip is a panel one level above the menu (.popUpMenu + 1). */
    const [menu, tip] = await waitFor(() => {
      const wins = windows(pid).filter((w) => w.layer !== STATUS_LAYER && w.layer > 0 && w.w > 30 && w.h > 30);
      if (wins.length < 2) return null;
      const top = Math.max(...wins.map((w) => w.layer));
      const panel = wins.find((w) => w.layer === top);
      const biggest = wins.filter((w) => w.layer < top).sort((a, b) => b.w * b.h - a.w * a.h)[0];
      return panel && biggest ? [biggest, panel] : null;
    }, "the menu with its New Box tip");
    await sleep(1200); // the menu's rows and the tip's placement settle
    const menuFile = join(work, "menu.png");
    const tipFile = join(work, "tip.png");
    const [m, t] = [windows(pid).find((w) => w.id === menu.id), windows(pid).find((w) => w.id === tip.id)];
    if (!m || !t) throw new Error(`the menu closed before the capture (was the Mac in use?). shots/${file} was not updated`);
    capture(m.id, menuFile);
    capture(t.id, tipFile);
    addBackdrop(menuFile);
    composite(out, [
      { file: menuFile, ...m },
      { file: tipFile, ...t },
    ]);
  } else if (windowArgs) {
    let win;
    for (let i = 0; i < 40 && !win; i++) {
      await sleep(250);
      win = windows(pid).find((w) => w.layer === 0 && w.w > 400 && w.h > 300);
    }
    if (!win) throw new Error(`the ${opts.manager ? "Manager" : "Settings"} window did not open`);
    await sleep(1500); // the timeline, the terminal and settings rows paint after the window appears
    capture(win.id, out);
  } else {
    await waitIdle();
    driver("open-menu", "--pid", String(pid));
    for (const id of opts.press) {
      driver("press", "--pid", String(pid), "--id", id);
      await sleep(700);
    }
    for (const [id, title] of opts.select) {
      driver("select", "--pid", String(pid), "--id", id, "--title", title, "--timeout", "5");
      await sleep(700);
    }
    await sleep(300);
    const wins = windows(pid).filter((w) => w.layer !== STATUS_LAYER && w.w > 30 && w.h > 30);
    if (!wins.length)
      throw new Error(`no ${opts.alert ? "alert" : "menu"} window on screen: it closed before the capture (was the Mac in use?). shots/${file} was not updated`);
    if (opts.window) {
      const win = await waitFor(() => windows(pid).find((w) => w.layer === 0 && w.w > 300 && w.h > 200), "the window");
      await sleep(1000);
      capture(win.id, out);
    } else if (opts.alert) {
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
  const how = [opts.setup && `--setup → ${opts.setup}`, opts.menuTip && "--menu-tip", ...opts.press, ...opts.select.map(([id, t]) => `${id} = ${t}`)].filter(Boolean);
  console.log(`shots/${file}  ←  ${PROC} --fixtures${opts.scenario ? ` --fixtures-scenario ${opts.scenario}` : ""}${how.length ? " · " + how.join(" → ") : ""}`);
} finally {
  if (quitAfter) await quit();
  else if (pidOf()) {
    try {
      driver("close-menu", "--pid", String(pidOf()));
    } catch {}
  }
}
