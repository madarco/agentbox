import path from 'node:path';

// `agentbox hub` ships a self-contained standalone build (traced node_modules) so
// the CLI can spawn the hub from a published install. Gated behind an env flag set
// only by `build:standalone` — the deploy builds (`next build` → `next start` /
// Vercel's adapter) stay non-standalone (next start doesn't support standalone).
const standalone = process.env.AGENTBOX_HUB_STANDALONE === '1';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  ...(standalone
    ? { output: 'standalone', outputFileTracingRoot: path.join(import.meta.dirname, '..', '..') }
    : {}),
  // Server-only packages that must not be bundled into Next's server output:
  // pg (dynamic require), and the AgentBox box-runtime packages (they shell out
  // to docker/ssh via execa and are read from node_modules at runtime by the
  // hub's data source + lifecycle server actions).
  serverExternalPackages: [
    'pg',
    'execa',
    '@agentbox/ctl',
    '@agentbox/sandbox-core',
    '@agentbox/sandbox-docker',
    '@agentbox/sandbox-daytona',
    '@agentbox/sandbox-hetzner',
    '@agentbox/sandbox-vercel',
    '@agentbox/sandbox-e2b',
  ],
};

export default config;
