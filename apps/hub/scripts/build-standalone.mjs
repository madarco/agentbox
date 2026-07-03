/**
 * Assemble a self-contained, spawnable hub for `agentbox hub`.
 *
 * `next build` (output:'standalone') produces `.next/standalone` — a traced tree
 * with a minimal `node_modules` — but its generated `server.js` is Next's own
 * minimal server, not our custom relay+Next server. So we:
 *   1. esbuild-bundle `server.ts` (our custom server) into `server.js` + lazy
 *      chunks, bundling the @agentbox box toolchain in and keeping `next`, the
 *      cloud providers/SDKs, and better-auth/pg external.
 *   2. Copy the standalone tree (relative symlinks preserved) + `.next/static`.
 *   3. Drop our `server.js` where Next's default one sat (sibling of `.next`).
 *
 * Output: `apps/hub/dist-standalone/` (mirrors the `.next/standalone` layout;
 * the runnable entry is `dist-standalone/apps/hub/server.js`). The CLI stage step
 * copies this into `apps/cli/runtime/hub/`.
 *
 * Run after `next build` (the `build:standalone` npm script chains them).
 */
import { createRequire } from 'node:module';
import { cp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hubDir = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const nextDir = path.join(hubDir, '.next');
const standaloneSrc = path.join(nextDir, 'standalone');
const outDir = path.join(hubDir, 'dist-standalone');
// The runnable app root inside the standalone tree (where `.next` + package.json live).
const appRel = path.relative(path.join(hubDir, '..', '..'), hubDir); // e.g. "apps/hub"
const outApp = path.join(outDir, appRel);

if (!existsSync(standaloneSrc)) {
  console.error(`[build-standalone] ${standaloneSrc} missing — run \`next build\` first.`);
  process.exit(1);
}

// esbuild is a transitive workspace dep; resolve it via tsup's tree.
const require = createRequire(import.meta.url);
const esbuild = require(
  createRequire(require.resolve('tsup')).resolve('esbuild'),
);

console.log('[build-standalone] esbuild-bundling server.ts …');
await esbuild.build({
  entryPoints: [path.join(hubDir, 'server.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: path.join(hubDir, '.standalone-server'),
  entryNames: 'server',
  splitting: true, // keep lazy import('./lib/auth') + dynamic cloud-provider imports as separate chunks
  external: [
    'next',
    'next/*',
    'pg',
    'pg-native',
    // dynamic-only cloud providers + their heavy SDKs: resolved from node_modules
    // at runtime, and only when a cloud box lifecycle action fires (never in the
    // common docker/localhost path).
    '@agentbox/sandbox-daytona',
    '@agentbox/sandbox-vercel',
    '@agentbox/sandbox-e2b',
    '@agentbox/sandbox-hetzner',
    '@daytonaio/sdk',
    '@vercel/sandbox',
    'e2b',
    // password-mode auth: lazy chunk, never loaded in localhost token mode.
    'better-auth',
    'better-auth/*',
    'kysely',
  ],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __f } from 'node:url'; import { dirname as __d } from 'node:path'; const require = __cr(import.meta.url); const __filename = __f(import.meta.url); const __dirname = __d(__filename);",
  },
  logLevel: 'warning',
});

console.log('[build-standalone] assembling dist-standalone …');
await rm(outDir, { recursive: true, force: true });
// Preserve the relative symlinks the traced pnpm tree uses (dereferencing bloats
// it ~4x). verbatimSymlinks keeps the ORIGINAL relative targets — the default
// (false) rewrites them to absolute source paths, which breaks a staged/published
// copy that no longer sits next to the source tree.
await cp(standaloneSrc, outDir, { recursive: true, verbatimSymlinks: true });
// Static assets aren't part of the traced server output — copy them in.
await cp(path.join(nextDir, 'static'), path.join(outApp, '.next', 'static'), { recursive: true });
// public/ isn't traced into the standalone output either; Next serves it from the
// app root at runtime, so copy it alongside .next (else /logo.svg, favicon, etc.
// fall through to the vercel [...path] catch-all → 503).
const publicSrc = path.join(hubDir, 'public');
if (existsSync(publicSrc)) {
  await cp(publicSrc, path.join(outApp, 'public'), { recursive: true });
}
// Overlay our bundled custom server (server.js + chunks) where Next's default sat.
const serverOut = path.join(hubDir, '.standalone-server');
for (const f of await readdir(serverOut)) {
  await cp(path.join(serverOut, f), path.join(outApp, f));
}
await rm(serverOut, { recursive: true, force: true });

console.log(`[build-standalone] done → ${path.relative(process.cwd(), path.join(outApp, 'server.js'))}`);
