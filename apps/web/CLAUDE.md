# apps/web — marketing site + docs

The public site for AgentBox: the marketing landing page **and** the Fumadocs
documentation. Deployed on Vercel as a single Next.js app.

## What it is

- A **Next.js 16 App Router** app (`@agentbox/web`), pnpm workspace member.
- **Docs** are authored as `.md` files under `content/docs/` and rendered by
  **Fumadocs** (`fumadocs-ui` / `fumadocs-core` / `fumadocs-mdx`) at `/docs`.
- The **marketing home** is the original hand-written static page, preserved
  verbatim at `public/home.html` and served at `/` (see rewrites below). It
  keeps its inline `<style>` and inline `<script>` (animated terminal, rotating
  agent name, interactive diagram) — that's why it stays a static document
  instead of being ported to React.
- Theme matches the AgentBox Docs design mockup (`AgentBox Docs.html`, kept in
  this folder as a non-served reference): light, green accent `#128a4f`, IBM
  Plex Sans/Mono.

## Layout

- `app/` — root layout (`RootProvider` + IBM Plex fonts), `app/docs/**` (docs
  shell + `[[...slug]]` renderer), `app/api/version` (version JSON endpoint).
- `app/global.css` — imports the Fumadocs preset, then maps the Fumadocs
  `--color-fd-*` variables onto the AgentBox design tokens. Edit theme here.
- `content/docs/` — the `.md` docs sources + `meta.json` (sidebar order).
- `lib/` — `source.ts` (Fumadocs loader), `layout.shared.tsx` (nav/brand/badge),
  `version.ts` (npm-registry fetch + fallback), generated `version-fallback.json`.
- `components/version-badge.tsx` — the version pill (docs nav).
- `components/figure.tsx` — `<Figure src? caption />`: a docs screenshot/diagram;
  renders a dashed placeholder until a `src` is added.
- `public/` — Next public root: `home.html` (the marketing page) + assets
  (`logo.svg`, favicons, `cover.jpg`, …) + generated `schema/` + `screenshots/`
  (docs figure images).
- `scripts/copy-schema.mjs` — prebuild step (see Build).
- `next.config.mjs` — `createMDX()` + rewrites.
- [`images.md`](./images.md) — **how to (re)capture every docs figure**: the one
  test environment to provision (boxes across docker/hetzner/vercel from
  `examples/express-ready`, with example prompts), the inline render + window-capture
  tooling, and the image catalog ordered by capture phase.

## Rewrites — important

`next.config.mjs` adds two `beforeFiles` rewrites:

- `/` → `/home.html` — serves the static marketing page at the site root.
- `/public/:path*` → `/:path*` — the marketing markup references assets with a
  legacy `/public/` prefix; this maps them to Next's public root, so the HTML
  needs no asset-path edits.

## Version badge

Latest AgentBox version, shown on both home and docs. Source of truth is
`apps/cli/package.json`.

- `lib/version.ts` fetches `registry.npmjs.org/@madarco/agentbox/latest` with
  hourly ISR (`revalidate: 3600`); on failure falls back to
  `lib/version-fallback.json`, snapshotted from `apps/cli/package.json` at build.
- Docs: `<VersionBadge/>` (Server Component) in the nav.
- Home: the static page fetches `/api/version` client-side and fills the pill.

## Build

- `pnpm dev` / `pnpm build` run `scripts/copy-schema.mjs` first (`predev` /
  `prebuild`): copies `agentbox.schema.json` + `user-config.schema.json` into
  `public/schema/`, and writes `lib/version-fallback.json` from the CLI version.
- `postinstall` runs `fumadocs-mdx` to generate the `.source` types.

## Deploy (Vercel)

- Next.js is auto-detected; **set the Vercel project Root Directory to
  `apps/web`**. No `vercel.json` needed (the old static one was removed; its
  schema copy now lives in `prebuild`).

## Conventions

- Theme via the `--color-fd-*` overrides + `--agb-*` tokens in `app/global.css`;
  reuse the existing tokens, don't invent new colors.
- New docs pages: add a `.md` under `content/docs/` and list it in `meta.json`.
- Docs figures: use `<Figure caption="…" />` (placeholder) and fill `src` from
  `public/screenshots/`; capture/recapture per [`images.md`](./images.md).
- No emojis in output unless asked.
