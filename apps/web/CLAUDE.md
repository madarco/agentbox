# apps/web — marketing site

The public marketing/landing site for AgentBox. Deployed on Vercel.

## What it is

- A **hand-written static site**, NOT a framework (no Astro/Vite/Next/React).
- The whole site is a single file: **`index.html`** — markup plus one big inline `<style>` block (no external CSS, no build step for the page itself).
- `public/` is a **literal subfolder**, not a framework-managed asset root.

## Layout

- `index.html` — the entire page (head + inline CSS + body). Edit this directly.
- `public/` — static assets:
  - `logo.svg`, `logo.png`
  - `favicon-16x16.png`, `favicon-32x32.png`, `favicon-256x256.png`
  - `site.webmanifest` — PWA manifest (icons + theme colors)
- `vercel.json` — deploy config.

## Asset URLs — important

`vercel.json` sets `"outputDirectory": "."`, so Vercel serves **this folder (`apps/web/`) as the site root**. There is no step that hoists `public/` to `/`. Therefore:

- Reference assets with the **`/public/` prefix**, e.g. `href="/public/favicon-32x32.png"`, `src="/public/logo.svg"`.
- Do NOT use `/favicon-32x32.png` (that 404s in production).

`vercel.json` also sets `"cleanUrls": true` (strips `.html` from page URLs; does not affect asset paths).

## Build

The page needs no build. `buildCommand` only copies JSON schemas into `schema/` for the docs:

```
mkdir -p schema && cp ../../packages/ctl/schema/agentbox.schema.json ../../packages/config/schema/user-config.schema.json schema/
```

## Conventions

- Keep styling in the single inline `<style>` block in `index.html`; match the existing CSS-variable design tokens (`:root { --paper, --ink, --accent: #128a4f, ... }`).
- No emojis in output unless asked.
- When adding assets, drop the file in `public/` and reference it as `/public/<name>`.
