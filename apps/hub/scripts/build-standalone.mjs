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
import { existsSync, readFileSync } from 'node:fs';
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

// The published bundle ships NO node_modules (see the cp filter below); the hub's
// externals — most importantly `next` — resolve from the installed
// @madarco/agentbox package's own node_modules. The compiled `.next` output is
// tied to the EXACT next version it was built against, so a drift between that and
// the CLI's declared `next` dependency would ship a broken hub. Fail loudly here.
{
  const nextVer = readPkgVersion('next', hubDir);
  const cliPkg = JSON.parse(readFileSync(path.join(hubDir, '..', 'cli', 'package.json'), 'utf8'));
  const cliNextSpec = cliPkg.dependencies?.next;
  if (nextVer && cliNextSpec !== nextVer) {
    console.error(
      `[build-standalone] next version drift: the hub was built against next@${nextVer}, ` +
        `but apps/cli/package.json pins next="${cliNextSpec ?? '(missing)'}". ` +
        `The compiled .next output requires the exact version — set dependencies.next to "${nextVer}".`,
    );
    process.exit(1);
  }
}

/** Version of an installed package resolvable from `fromDir` (bypasses `exports`). */
function readPkgVersion(name, fromDir) {
  try {
    const entry = createRequire(path.join(fromDir, 'noop.js')).resolve(name);
    for (let dir = path.dirname(entry); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const pj = path.join(dir, 'package.json');
      if (existsSync(pj)) {
        const j = JSON.parse(readFileSync(pj, 'utf8'));
        if (j.name === name) return j.version;
      }
    }
  } catch {
    /* best effort — if we can't resolve it, skip the guard rather than block the build */
  }
  return null;
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
    // The @agentbox/sandbox-* providers are private:true workspace packages
    // (never published to npm), so a fresh `npm i -g` install has no node_modules
    // to resolve them from — bundle them IN. Their heavy, npm-published SDKs stay
    // external (they're real deps of @madarco/agentbox) and are only pulled when a
    // cloud box lifecycle action fires (never on the docker/localhost path).
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
// Ship NO node_modules. The traced pnpm store here (relative symlinks + a `.pnpm`
// virtual store) is correct on-disk but does NOT survive `npm publish` — npm
// mangles the symlink tree, so the installed hub's `next` symlink dangles →
// `Cannot find package 'next'`. Instead the hub's externals resolve from the
// installed @madarco/agentbox package's own node_modules (next/react/react-dom/
// pg/better-auth/kysely + the cloud SDKs are declared as its dependencies). This
// also drops ~44M of dead weight from the tarball.
await cp(standaloneSrc, outDir, {
  recursive: true,
  filter: (src) => !src.split(path.sep).includes('node_modules'),
});
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

// The E2B provider's attach helper is a standalone .cjs the resident worker spawns
// to start the agent detached (E2B has no SSH). `resolveAttachHelperPath` looks for
// it next to the running bundle, so a hub-created e2b box would come up but its
// `-i` agent-start fails ("e2b attach helper not found") without this copy.
const e2bHelperSrc = path.join(hubDir, '..', '..', 'packages', 'sandbox-e2b', 'dist', 'attach-helper.cjs');
if (existsSync(e2bHelperSrc)) {
  await cp(e2bHelperSrc, path.join(outApp, 'attach-helper.cjs'));
  console.log('[build-standalone] staged e2b attach-helper.cjs');
}

console.log(`[build-standalone] done → ${path.relative(process.cwd(), path.join(outApp, 'server.js'))}`);
