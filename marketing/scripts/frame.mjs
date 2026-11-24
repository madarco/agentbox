/* The social frame: one screen on an AgentBox-branded canvas at a post size.
   `frame()` returns a whole HTML document. `pnpm export` renders it with
   Playwright, and the gallery shows the same document in an iframe as its
   preview (screens.mjs injects this file's source), so what the gallery shows
   is what the export writes. Keep it self-contained: no imports, no closures. */

export const FORMATS = {
  "16x9": { w: 1920, h: 1080, use: "X, LinkedIn, YouTube, website" },
  "1x1": { w: 1080, h: 1080, use: "Feed posts" },
  "4x5": { w: 1080, h: 1350, use: "Instagram and LinkedIn portrait feed" },
  "9x16": { w: 1080, h: 1920, use: "Reels, TikTok, Shorts, Stories" },
};

/* src: the image URL; w, h: its pixel size; o.title: an optional headline;
   o.kind: "page" (an opaque full page: rounded card + shadow) or "cutout"
   (a picture with its own transparent edge: a menu, a terminal window);
   o.crop: [x, y, w, h] in image pixels, to show one part of a tall page. */
export function frame(src, imgW, imgH, format, o = {}) {
  const [cx, cy, w, h] = o.crop ?? [0, 0, imgW, imgH];
  const F = {
    "16x9": { w: 1920, h: 1080 },
    "1x1": { w: 1080, h: 1080 },
    "4x5": { w: 1080, h: 1350 },
    "9x16": { w: 1080, h: 1920 },
  }[format];
  const pad = Math.round(Math.min(F.w, F.h) * 0.075);
  const head = o.title ? Math.round(F.h * (F.h > F.w ? 0.16 : 0.17)) : Math.round(F.h * 0.08);
  const boxW = F.w - pad * 2;
  const boxH = F.h - head - pad * 1.2;
  const scale = Math.min(boxW / w, boxH / h, o.maxScale ?? 1);
  const dw = Math.round(w * scale);
  const dh = Math.round(h * scale);
  const titleSize = Math.round(Math.min(F.w, F.h) * (F.w > F.h ? 0.05 : 0.062));
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const card = o.kind === "cutout"
    ? "filter: drop-shadow(0 18px 40px rgb(22 26 32 / .22));"
    : "border-radius: 14px; box-shadow: 0 0 0 1px rgb(22 26 32 / .08), 0 30px 70px rgb(22 26 32 / .22);";
  return `<!doctype html><meta charset="utf-8"><style>
html, body { margin: 0; }
.c { position: relative; width: ${F.w}px; height: ${F.h}px; overflow: hidden; background: #f4f2ec;
  background-image: radial-gradient(circle at 85% 10%, rgb(18 138 79 / .14), transparent 45%),
    radial-gradient(circle at 5% 95%, rgb(12 107 61 / .10), transparent 40%),
    linear-gradient(rgb(22 26 32 / .045) 1px, transparent 1px), linear-gradient(90deg, rgb(22 26 32 / .045) 1px, transparent 1px);
  background-size: auto, auto, 48px 48px, 48px 48px; font-family: "IBM Plex Sans", -apple-system, "SF Pro Display", system-ui, sans-serif; color: #161a20; }
.brand { position: absolute; left: ${pad}px; top: ${Math.round(pad * 0.62)}px; display: flex; align-items: center; gap: 12px;
  font: 600 ${Math.round(titleSize * 0.55)}px "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: -.01em; }
.brand svg { width: ${Math.round(titleSize * 0.8)}px; height: ${Math.round(titleSize * 0.8)}px; }
.title { position: absolute; left: ${pad}px; right: ${pad}px; top: ${Math.round(pad * 0.62 + titleSize * 1.05)}px;
  font-size: ${titleSize}px; line-height: 1.12; font-weight: 650; letter-spacing: -.02em; }
.shot { position: absolute; left: ${Math.round((F.w - dw) / 2)}px; top: ${Math.round(head + (boxH - dh) / 2 + pad * 0.2)}px;
  width: ${dw}px; height: ${dh}px; ${card} }
</style><div class="c">
<div class="brand"><svg viewBox="0 0 385 382" fill="none"><path d="M325 16H59C35.8 16 17 34.8 17 58V324C17 347.2 35.8 366 59 366H325C348.2 366 367 347.2 367 324V58C367 34.8 348.2 16 325 16Z" fill="#F6F6F3" stroke="#161A20" stroke-width="31"/><path d="M255 191H129V317H255V191Z" stroke="#161A20" stroke-width="10"/><path d="M236 210H148V298H236V210Z" fill="#0C6B3D"/></svg>agentbox</div>
${o.title ? `<div class="title">${esc(o.title)}</div>` : ""}
<div class="shot" style="background: url('${src}') ${-Math.round(cx * scale)}px ${-Math.round(cy * scale)}px / ${Math.round(imgW * scale)}px auto no-repeat"></div>
</div>`;
}
