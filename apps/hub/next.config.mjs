/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
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
