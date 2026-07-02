import path from 'node:path';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Self-contained build for `agentbox hub`: `.next/standalone` bundles a traced
  // node_modules so the CLI can spawn the hub from a published install without a
  // full dependency tree. The tracing root is the monorepo root so workspace
  // packages (@agentbox/relay, imported by server.ts) get traced in.
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '..', '..'),
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
