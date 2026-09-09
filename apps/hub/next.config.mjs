import path from 'node:path';

// `agentbox hub` ships a self-contained standalone build (traced node_modules) so
// the CLI can spawn the hub from a published install. Gated behind an env flag set
// only by `build:standalone` — the deploy builds (`next build` → `next start` /
// Vercel's adapter) stay non-standalone (next start doesn't support standalone).
const standalone = process.env.AGENTBOX_HUB_STANDALONE === '1';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // When the hub is served through the Portless proxy at https://agentbox.localhost
  // (see `agentbox hub`), the browser's Origin is agentbox.localhost while the
  // proxy forwards to 127.0.0.1:8787. Next's default Server-Actions CSRF check
  // compares Origin to Host and would 403 the dashboard's `use server` actions;
  // allowlist the proxied origin so they work over both the loopback and the
  // friendly URL. (Fixed hostname → static entry.)
  experimental: {
    serverActions: {
      allowedOrigins: ['agentbox.localhost'],
    },
  },
  ...(standalone
    ? {
        output: 'standalone',
        outputFileTracingRoot: path.join(import.meta.dirname, '..', '..'),
        // The tracer walks from the MONOREPO ROOT, so without this it sweeps the
        // previous build's `dist-standalone` into `.next/standalone` — which the
        // assemble step then copies back into `dist-standalone`, one level deeper
        // every build. Thirteen builds took the published tarball from 25MB to
        // 107MB before anyone noticed. `.next` is excluded for the same reason.
        outputFileTracingExcludes: {
          '*': ['**/dist-standalone/**', '**/.next/standalone/**'],
        },
      }
    : {}),
  // Server-only packages that must not be bundled into Next's server output:
  // pg (dynamic require), and the AgentBox box-runtime packages (they shell out
  // to docker/ssh via execa and are read from node_modules at runtime by the
  // hub's data source + lifecycle server actions).
  //
  // `execa` is deliberately NOT here. Listing it made turbopack emit an async
  // external under a GENERATED id — `e.y("execa-<hash>")` — that names no
  // package on disk, so every server-rendered PAGE died with
  // ERR_MODULE_NOT_FOUND while the API routes, which never load that chunk,
  // stayed fine. It is imported by the @agentbox/* packages that are NOT
  // external here (relay, sandbox-cloud, …), so turbopack has to resolve it
  // either way. Bundling is safe: execa is plain ESM over `node:` builtins,
  // with none of the dynamic requires that force `pg` out.
  serverExternalPackages: [
    'pg',
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
