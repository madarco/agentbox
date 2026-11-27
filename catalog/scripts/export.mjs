#!/usr/bin/env node
/*
 * Exports a screen from the catalog at social-post sizes: the screenshot on an
 * AgentBox-branded canvas (scripts/frame.mjs, the same layout the gallery
 * previews), written to out/social/.
 *
 *   pnpm export hub/skills                      # every format: 16x9, 1x1, 4x5, 9x16 (the simple picture, if any)
 *   pnpm export hub/skills --scenario full      # the entry's first picture of that scenario
 *   pnpm export hub/skills --format 16x9,1x1
 *   pnpm export tray/menu --title "Every box, one click away"
 *   pnpm export cli/install --file 1            # the entry's second picture
 *   pnpm export hub/usage --crop 0,0,2880,1800  # a part of a tall page, in image pixels
 *   pnpm export cli/ls --no-title
 *
 * Without --file or --scenario it exports the entry's first `simple` picture
 * (the calm demo data, made for posts), else its cover. The file name carries
 * a scenario other than full: out/social/hub-skills.simple-16x9.png.
 *
 * The headline, crop and kind default to the entry's `social` in
 * screens/catalog.mjs. Set MARKETING_ASSETS to also copy each file there
 * (e.g. a marketing assets folder).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { FORMATS, frame } from "./frame.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { SCREENS } = await import(join(root, "screens/catalog.mjs"));
const pathOf = (file) => (file.startsWith("docs:") ? join(root, "../apps/web/public/screenshots", file.slice(5)) : join(root, "shots", file));

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv.splice(i, 2)[1];
};
const bool = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? false : (argv.splice(i, 1), true);
};
const formats = (flag("--format") ?? Object.keys(FORMATS).join(",")).split(",");
const fileFlag = flag("--file");
const scenario = flag("--scenario");
const title = flag("--title");
const crop = flag("--crop");
const noTitle = bool("--no-title");
const [id] = argv;
const s = SCREENS.find((x) => x.id === id);
if (!s) {
  console.error(`usage: pnpm export <screen id> [--format 16x9,1x1,4x5,9x16] [--file n] [--title "..."] [--crop x,y,w,h] [--no-title]`);
  if (id) console.error(`no screen "${id}" in screens/catalog.mjs`);
  process.exit(1);
}
for (const f of formats) if (!FORMATS[f]) throw new Error(`unknown format ${f}: ${Object.keys(FORMATS).join(", ")}`);
const scenarioOf = (x) => x.scenario ?? "full";
const pick = (sc) => s.files.findIndex((x) => scenarioOf(x) === sc && existsSync(pathOf(x.file)));
let fileIndex;
if (fileFlag !== null) fileIndex = Number(fileFlag);
else if (scenario) {
  fileIndex = pick(scenario);
  if (fileIndex === -1) throw new Error(`${id}: no ${scenario} picture`);
} else fileIndex = pick("simple") === -1 ? (s.cover ?? 0) : pick("simple");
const f = s.files[fileIndex];
if (!f || !existsSync(pathOf(f.file))) throw new Error(`${id}: no picture ${fileIndex} (run pnpm screens check)`);

const png = readFileSync(pathOf(f.file));
const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
const opts = { kind: "page", ...(s.social ?? {}) };
if (title) opts.title = title;
if (noTitle) delete opts.title;
if (crop) opts.crop = crop.split(",").map(Number);
const src = `data:image/png;base64,${png.toString("base64")}`;

const outDir = join(root, "out/social");
mkdirSync(outDir, { recursive: true });
const assets = process.env.MARKETING_ASSETS ? resolve(process.env.MARKETING_ASSETS) : null;
/* hub-dashboard.simple-1: the entry's second simple picture. */
const nth = s.files.filter((x) => scenarioOf(x) === scenarioOf(f)).indexOf(f);
const base = id.replace(/\//g, "-") + (scenarioOf(f) === "full" ? "" : `.${scenarioOf(f)}`) + (nth ? `-${nth}` : "");

const browser = await chromium.launch();
try {
  for (const format of formats) {
    const F = FORMATS[format];
    const page = await browser.newPage({ viewport: { width: F.w, height: F.h }, deviceScaleFactor: 1 });
    await page.setContent(frame(src, w, h, format, opts), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const out = join(outDir, `${base}-${format}.png`);
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: F.w, height: F.h } });
    await page.close();
    console.log(`out/social/${base}-${format}.png  ${F.w}×${F.h}`);
    if (assets) {
      mkdirSync(join(assets, "screens"), { recursive: true });
      copyFileSync(out, join(assets, "screens", `${base}-${format}.png`));
    }
  }
} finally {
  await browser.close();
}
