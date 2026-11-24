#!/usr/bin/env node
/*
 * Builds the screen catalog: screens/index.html, from screens/catalog.mjs (one
 * entry per screen) and screens/setups.mjs (how to start each environment).
 * See README.md.
 *
 *   pnpm screens               # build, and list what is wrong
 *   pnpm screens open          # build and open it in the browser
 *   pnpm screens check         # build, and fail if anything is wrong
 *   pnpm screens serve         # build and serve it at http://127.0.0.1:3124/screens/
 *   pnpm screens retake [id]   # run the shoot commands again: every entry, one id, or an id prefix (hub/, tray/, cli/)
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(root, "shots");
const DOCS = join(root, "../apps/web/public/screenshots");
const { SCREENS, TOPICS } = await import(join(root, "screens/catalog.mjs"));
const { SETUPS } = await import(join(root, "screens/setups.mjs"));
const frameSource = readFileSync(join(root, "scripts/frame.mjs"), "utf8");

/* "docs:x.png" is a docs-site screenshot; anything else is under shots/. */
const pathOf = (file) => (file.startsWith("docs:") ? join(DOCS, file.slice(5)) : join(shots, file));
const urlOf = (file) => (file.startsWith("docs:") ? "../../apps/web/public/screenshots/" + file.slice(5) : "../shots/" + file);
const repoPath = (file) => (file.startsWith("docs:") ? "apps/web/public/screenshots/" + file.slice(5) : "catalog/shots/" + file);

const mode = process.argv[2];

if (mode === "retake") {
  const want = process.argv[3];
  const list = SCREENS.filter((s) => !want || s.id === want || s.id.startsWith(want));
  let failed = 0;
  for (const s of list)
    for (const f of s.files) {
      if (!f.shoot) continue;
      console.log(`\n$ ${f.shoot}`);
      const r = spawnSync("sh", ["-c", f.shoot.replace(/^pnpm /, "pnpm -s ")], { cwd: root, stdio: "inherit" });
      if (r.status !== 0) failed++;
    }
  if (failed) {
    console.error(`\n${failed} shot(s) failed`);
    process.exit(1);
  }
}

/* PNG size from its IHDR, so the gallery and the export know each picture's shape. */
function size(path) {
  const b = readFileSync(path);
  if (b.toString("ascii", 1, 4) !== "PNG") return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const problems = [];
const ids = new Set();
const listed = new Set();
for (const s of SCREENS) {
  if (ids.has(s.id)) problems.push(`${s.id}: the id is used twice`);
  ids.add(s.id);
  if (!TOPICS.includes(s.topic)) problems.push(`${s.id}: topic "${s.topic}" is not in TOPICS`);
  if (!SETUPS[s.setup]) problems.push(`${s.id}: setup "${s.setup}" is not in setups.mjs`);
  if (!s.files?.length) problems.push(`${s.id}: no files`);
  for (const f of s.files ?? []) {
    if (!existsSync(pathOf(f.file))) problems.push(`${s.id}: ${repoPath(f.file)} does not exist`);
    else Object.assign(f, size(pathOf(f.file)));
    if (listed.has(f.file)) problems.push(`${s.id}: ${f.file} is in two entries`);
    listed.add(f.file);
  }
}
for (const s of SCREENS) if (s.from && !ids.has(s.from)) problems.push(`${s.id}: from "${s.from}" is not a screen`);

/* Every picture under shots/ belongs to an entry. */
const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? walk(p) : /\.(png|jpe?g|webp)$/.test(name) ? [relative(shots, p)] : [];
      })
    : [];
for (const file of walk(shots)) if (!listed.has(file)) problems.push(`shots/${file} is not in the catalog`);

const screens = SCREENS.map((s) => ({ ...s, files: s.files.map((f) => ({ ...f, url: urlOf(f.file), path: repoPath(f.file) })) }));
const data = { screens, setups: SETUPS, topics: TOPICS };
const page = readFileSync(join(root, "screens/template.html"), "utf8")
  .replace("const DATA = __DATA__;", () => `const DATA = ${JSON.stringify(data).replace(/</g, "\\u003c")};`)
  .replace("/* __FRAME__ */", () => frameSource.replace(/^export /gm, ""));
const out = join(root, "screens/index.html");
writeFileSync(out, page);

const files = SCREENS.reduce((n, s) => n + s.files.length, 0);
console.log(`screens/index.html: ${SCREENS.length} screens, ${files} files`);
for (const p of problems) console.error(`  ! ${p}`);

if (mode === "open") spawnSync("open", [out]);
if (mode === "check" && problems.length) process.exit(1);

/* For previews that cannot open a file: the gallery and its pictures only. */
if (mode === "serve") {
  const types = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
  const port = Number(process.env.PORT ?? 3124);
  const repo = join(root, "..");
  createServer((req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (path === "/" || path === "/screens") return res.writeHead(302, { location: "/catalog/screens/" }).end();
    if (path === "/catalog/screens/") path = "/catalog/screens/index.html";
    const file = join(repo, path);
    const ok =
      (path === "/catalog/screens/index.html" || path.startsWith("/catalog/shots/") || path.startsWith("/apps/web/public/screenshots/")) &&
      types[extname(file)];
    if (!ok || !existsSync(file)) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": types[extname(file)] }).end(readFileSync(file));
  }).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/catalog/screens/`));
}
