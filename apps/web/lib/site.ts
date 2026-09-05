// Canonical site metadata, shared by the root layout (defaults) and the docs
// pages (per-page overrides). Mirrors the hand-written <head> in
// `public/home.html` so the Next-rendered docs match the static marketing page.
export const SITE = {
  url: 'https://agent-box.sh',
  name: 'AgentBox',
  title: 'AgentBox — Teleport for agents',
  description:
    'AgentBox teleports your project into an isolated VM — local or in the cloud — and runs Claude Code, Codex, OpenCode, or Pi inside it. Checkpointed, parallel, on hardware you control.',
  twitterCreator: '@madarco',
  ogImage: {
    url: '/cover.jpg',
    width: 1586,
    height: 992,
    alt: 'AgentBox — one command teleport for coding agents',
  },
} as const;
