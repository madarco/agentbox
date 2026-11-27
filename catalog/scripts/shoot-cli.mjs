#!/usr/bin/env node
/*
 * Takes a screenshot of the agentbox CLI: runs it in a real PTY (the repo's
 * `pnpm drive` harness, apps/cli/test/_harness), reads the rendered terminal
 * back with its colours, and draws it in a terminal window into shots/.
 *
 *   pnpm shoot:cli <file under shots/> [options] -- <agentbox args...>
 *
 *   pnpm shoot:cli cli/ls.png --cols 118 -- ls --global
 *   pnpm shoot:cli cli/install.png --rows 30 --wait-for "Which" -- install
 *   pnpm shoot:cli cli/dashboard.png --cols 150 --rows 40 --wait-for "Sessions" -- dashboard
 *
 * The CLI runs with HOME set to a scratch folder (catalog/.cache/cli-home)
 * whose config points `relay.port` at the fixture hub (3126), so every command
 * that reads boxes through the hub sees the Acme demo data and nothing of the
 * owner's ~/.agentbox. Start `pnpm fixture-hub` first.
 *
 * The prompt line above the output ("~/Projects/commerce ❯ agentbox ls") is
 * drawn, not typed: the command really ran as `node apps/cli/dist/index.js`.
 *
 * Options
 *   --cols <n> --rows <n>   terminal size (default 110x28)
 *   --cwd <dir>             where the command runs (default the scratch HOME)
 *   --shown-cwd <path>      the folder the prompt line shows (default ~/Projects/commerce)
 *   --wait-for <text>       wait until the screen shows this (default: 2.5s)
 *   --send <keys>           keystrokes after it shows, in the harness DSL (<Down>, <Enter>, <C-c>); repeat
 *   --settle <ms>           wait after the last key (default 800)
 *   --no-prompt             no prompt line (a full-screen TUI)
 *   --first-run             no ~/.agentbox/setup-complete.json in the scratch HOME, so any
 *                           command opens the first-run setup wizard (`agentbox install`)
 *   --title <text>          the window title (default "agentbox")
 *   --scale <n>             pixel density (default 2)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { MACHINES, skillCompare, skillMd } from "../fixtures/acme.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "..");
const home = join(root, ".cache/cli-home");
const CLI = process.env.AGENTBOX_CLI ?? join(repo, "apps/cli/dist/index.js");

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
if (dash === -1) {
  console.error("Usage: pnpm shoot:cli <file under shots/> [options] -- <agentbox args...>   (the header of scripts/shoot-cli.mjs lists them)");
  process.exit(1);
}
const cmd = argv.slice(dash + 1);
const opts = { cols: 110, rows: 28, cwd: home, shownCwd: "~/Projects/commerce", send: [], settle: 800, title: "agentbox", scale: 2, prompt: true };
const rest = [];
const own = argv.slice(0, dash);
for (let i = 0; i < own.length; i++) {
  const a = own[i];
  const v = () => own[++i];
  if (a === "--cols") opts.cols = Number(v());
  else if (a === "--rows") opts.rows = Number(v());
  else if (a === "--cwd") opts.cwd = resolve(v());
  else if (a === "--shown-cwd") opts.shownCwd = v();
  else if (a === "--wait-for") opts.waitFor = v();
  else if (a === "--send") opts.send.push(v());
  else if (a === "--settle") opts.settle = Number(v());
  else if (a === "--title") opts.title = v();
  else if (a === "--scale") opts.scale = Number(v());
  else if (a === "--no-prompt") opts.prompt = false;
  else if (a === "--first-run") opts.firstRun = true;
  else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
  else rest.push(a);
}
const [file] = rest;
if (!file || !cmd.length) throw new Error("need a file and a command after --");

/* The scratch HOME: the CLI's local hub is the fixture hub. The token is a
   placeholder the fixture hub never checks. */
mkdirSync(join(home, ".agentbox/hub"), { recursive: true });
writeFileSync(join(home, ".agentbox/config.yaml"), "relay:\n  port: 3126\n");
writeFileSync(join(home, ".agentbox/hub/token"), "fixture-not-a-secret\n");
/* This PC's own skills, as the hub's comparison of studio-mac lists them
   (acme.mjs), so `agentbox skills` has a local side to compare. */
for (const dir of [".claude/skills", ".agents/skills"]) rmSync(join(home, dir), { recursive: true, force: true });
for (const r of skillCompare[MACHINES.studio].rows) {
  if (!r.pc) continue;
  const dir = join(home, r.pc.dirs[0], r.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd[r.name] ?? `---\nname: ${r.name}\ndescription: ${r.description}\n---\n\n# ${r.name}\n`);
}
const marker = join(home, ".agentbox/setup-complete.json");
if (opts.firstRun) rmSync(marker, { force: true });
else writeFileSync(marker, JSON.stringify({ version: 1, completedAt: "2026-11-01T09:00:00.000Z", provider: "docker" }) + "\n");

const drive = (...a) => execFileSync("pnpm", ["-s", "-C", repo, "drive", ...a], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A command that exits would take the PTY with it: keep the shell around. The
   harness joins its argv into one shell line, so the command goes in a script. */
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const script = join(root, ".cache/shoot-cli.sh");
writeFileSync(script, `node ${[CLI, ...cmd].map(q).join(" ")}\nsleep 600\n`);
const id = drive(
  "start", "--name", "shoot", "--cols", String(opts.cols), "--rows", String(opts.rows), "--cwd", opts.cwd,
  "--env", `HOME=${home}`, "--env", "AGENTBOX_NO_UPDATE_CHECK=1", "--env", "TERM=xterm-256color", "--env", "COLORTERM=truecolor",
  "--", "bash", script,
);
let screen;
try {
  if (opts.waitFor) drive("wait", id, "--text", opts.waitFor, "--timeout", "30000");
  else await sleep(2500);
  for (const keys of opts.send) {
    drive("send", id, keys);
    await sleep(400);
  }
  await sleep(opts.settle);
  screen = drive("screen", id, "--ansi");
} finally {
  spawnSync("pnpm", ["-s", "-C", repo, "drive", "stop", id]);
}

/* ---- ANSI (SGR only: the harness re-renders the screen) → HTML ---- */
const BASE16 = ["#1d1f21", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d7dae0",
  "#5c6370", "#ef8891", "#b5e890", "#f0d38a", "#82c1ff", "#d898ec", "#7ad2dc", "#ffffff"];
const xterm256 = (n) => {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const c = n - 16, s = [0, 95, 135, 175, 215, 255];
    return `rgb(${s[Math.floor(c / 36)]},${s[Math.floor(c / 6) % 6]},${s[c % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
};
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function toHtml(line) {
  let st = {};
  let html = "";
  const parts = line.split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const codes = parts[i] === "" ? [0] : parts[i].split(";").map(Number);
      for (let j = 0; j < codes.length; j++) {
        const c = codes[j];
        if (c === 0) st = {};
        else if (c === 1) st.bold = true;
        else if (c === 2) st.dim = true;
        else if (c === 3) st.italic = true;
        else if (c === 4) st.underline = true;
        else if (c === 7) st.inverse = true;
        else if (c === 22) st.bold = st.dim = false;
        else if (c === 23) st.italic = false;
        else if (c === 24) st.underline = false;
        else if (c === 27) st.inverse = false;
        else if (c >= 30 && c <= 37) st.fg = BASE16[c - 30];
        else if (c >= 90 && c <= 97) st.fg = BASE16[c - 82];
        else if (c === 39) delete st.fg;
        else if (c >= 40 && c <= 47) st.bg = BASE16[c - 40];
        else if (c >= 100 && c <= 107) st.bg = BASE16[c - 92];
        else if (c === 49) delete st.bg;
        else if (c === 38 || c === 48) {
          const key = c === 38 ? "fg" : "bg";
          if (codes[j + 1] === 5) { st[key] = xterm256(codes[j + 2]); j += 2; }
          else if (codes[j + 1] === 2) { st[key] = `rgb(${codes[j + 2]},${codes[j + 3]},${codes[j + 4]})`; j += 4; }
        }
      }
      continue;
    }
    if (!parts[i]) continue;
    let fg = st.fg, bg = st.bg;
    if (st.inverse) [fg, bg] = [bg ?? "var(--bg)", fg ?? "var(--fg)"];
    const css = [fg && `color:${fg}`, bg && `background:${bg}`, st.bold && "font-weight:700", st.dim && "opacity:.6",
      st.italic && "font-style:italic", st.underline && "text-decoration:underline"].filter(Boolean).join(";");
    html += css ? `<span style="${css}">${esc(parts[i])}</span>` : esc(parts[i]);
  }
  return html;
}

let lines = screen.split("\n");
while (lines.length && !lines.at(-1).replace(/\x1b\[[0-9;]*m/g, "").trim()) lines.pop();
if (opts.prompt) while (lines.length && !lines[0].replace(/\x1b\[[0-9;]*m/g, "").trim()) lines.shift();
const shown = `agentbox ${cmd.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
const promptLine = `<span style="color:#61afef">${esc(opts.shownCwd)}</span> <span style="color:#c678dd">❯</span> ${esc(shown)}`;
const body = [...(opts.prompt ? [promptLine] : []), ...lines.map(toHtml)].join("\n");

const page = `<!doctype html><meta charset="utf-8"><style>
:root { --bg: #16181d; --fg: #d7dae0; }
html, body { margin: 0; background: transparent; }
.win { display: inline-block; margin: 40px; border-radius: 12px; overflow: hidden; background: var(--bg);
  box-shadow: 0 24px 60px rgb(0 0 0 / .35), 0 0 0 1px rgb(255 255 255 / .08); }
.bar { height: 38px; display: flex; align-items: center; padding: 0 14px; background: #22252b; position: relative;
  font: 600 13px -apple-system, "SF Pro Text", system-ui, sans-serif; color: #9aa0aa; }
.dot { width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; }
.title { position: absolute; left: 0; right: 0; text-align: center; pointer-events: none; }
pre { margin: 0; padding: 16px 20px 20px; color: var(--fg); font: 13.5px/1.45 "JetBrains Mono", "SF Mono", Menlo, monospace;
  width: ${opts.cols}ch; white-space: pre; }
</style><div class="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="title">${esc(opts.title)}</span></div><pre>${body}</pre></div>`;

const out = join(root, "shots", file);
mkdirSync(dirname(out), { recursive: true });
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ deviceScaleFactor: opts.scale, viewport: { width: 2400, height: 1600 } });
  const p = await ctx.newPage();
  await p.setContent(page);
  await p.evaluate(() => document.fonts.ready);
  const box = await p.locator(".win").boundingBox();
  await p.screenshot({ path: out, omitBackground: true, clip: { x: box.x - 40, y: box.y - 40, width: box.width + 80, height: box.height + 80 } });
} finally {
  await browser.close();
}
console.log(`shots/${file}  ←  ${shown}  (${opts.cols}x${opts.rows})`);
