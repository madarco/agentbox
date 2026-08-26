#!/usr/bin/env node
// Guards the injected cloud-backend wiring in the BUILT bundles.
//
// The relay resolves cloud backends (git push / download / gh pr head probe) for
// a cloud box. Its own bundle carries no `@agentbox/sandbox-*` packages — those
// are private workspace packages — so each host bundle must inject a loader:
//
//   apps/cli   -> dist/cloud-backends.js, side-loaded by the spawned relay bin
//                 through AGENTBOX_CLOUD_BACKENDS (set in spawnRelay).
//   apps/hub   -> registered in-process by server.ts before startRelayDaemon.
//
// This never fails in the pnpm dev tree — there the old bare-specifier import
// resolves through workspace symlinks — so only a check against the built
// artifacts catches a regression before it ships. Assertions deliberately anchor
// on string literals and runtime behavior, never on identifiers or chunk names,
// which the bundler renames freely.
//
// Usage: node scripts/check-cloud-backend-wiring.mjs   # exit 1 on a broken wiring
//
// Requires `pnpm build` and `pnpm --filter @agentbox/hub build:standalone`.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function fail(msg, fix) {
  failures.push(fix ? `✗ ${msg}\n  Fix: ${fix}` : `✗ ${msg}`);
}

function mustExist(rel, fix) {
  if (existsSync(join(repoRoot, rel))) return true;
  fail(`${rel} is missing`, fix);
  return false;
}

function mustContain(rel, needle, why) {
  const text = readFileSync(join(repoRoot, rel), 'utf8');
  if (text.includes(needle)) return;
  fail(`${rel} does not contain ${JSON.stringify(needle)} — ${why}`);
}

/** Recursively collect .js/.cjs files under a built tree. */
function bundleFiles(absDir) {
  const out = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) out.push(...bundleFiles(abs));
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

function treeMustContain(relDir, needle, why) {
  const hit = bundleFiles(join(repoRoot, relDir)).some((f) =>
    readFileSync(f, 'utf8').includes(needle),
  );
  if (!hit) fail(`no file under ${relDir} contains ${JSON.stringify(needle)} — ${why}`);
}

const BUILD = 'run `pnpm build`';
const BUILD_HUB = 'run `pnpm --filter @agentbox/hub build:standalone`';

// ── 1. CLI: the side-loaded loader entry ──────────────────────────────────
const cliEntry = 'apps/cli/dist/cloud-backends.js';
if (mustExist(cliEntry, `${BUILD} (tsup entry "cloud-backends" in apps/cli/tsup.config.ts)`)) {
  mustContain(cliEntry, 'agentbox:builtin-cloud-backends', 'the loader marker should be inlined');
  // A static `@agentbox/sandbox-cloud` import (or eagerly-imported providers)
  // would balloon this entry and drag the relay's own module graph back in.
  const bytes = statSync(join(repoRoot, cliEntry)).size;
  if (bytes > 100_000) {
    fail(
      `${cliEntry} is ${String(bytes)} bytes — expected a small stub; ` +
        'a provider or @agentbox/sandbox-cloud is probably imported statically instead of lazily',
    );
  }
}

// ── 2. CLI: the spawned relay bin reads the env var ───────────────────────
const relayBin = 'apps/cli/runtime/relay/bin.cjs';
if (mustExist(relayBin, `${BUILD} (staged by apps/cli/scripts/stage-runtime.mjs)`)) {
  mustContain(relayBin, 'AGENTBOX_CLOUD_BACKENDS', 'the relay bin must read the loader path');
  mustContain(relayBin, 'agentbox:env:', 'the relay bin must register the side-loaded loader');
}

// ── 3. Hub: in-process registration ───────────────────────────────────────
const hubStandalone = 'apps/hub/dist-standalone/apps/hub';
if (mustExist(hubStandalone, BUILD_HUB)) {
  treeMustContain(
    hubStandalone,
    'agentbox:hub-builtin-cloud-backends',
    'apps/hub/server.ts must register the loader before startRelayDaemon',
  );
}
// The CLI stages a copy of the hub bundle; a stale one ships a hub that can't
// resolve backends even though the fresh build can.
const stagedHub = 'apps/cli/runtime/hub/apps/hub';
if (existsSync(join(repoRoot, stagedHub))) {
  const before = failures.length;
  treeMustContain(
    stagedHub,
    'agentbox:hub-builtin-cloud-backends',
    'the staged hub bundle is stale',
  );
  if (failures.length > before) {
    failures[failures.length - 1] +=
      '\n  Fix: re-run `pnpm --filter @agentbox/hub build:standalone` then `pnpm --filter @madarco/agentbox stage`';
  }
}

// ── 4. Behavioral probe of the built CLI entry ────────────────────────────
// The only assertion immune to bundler churn: load it and use it.
if (existsSync(join(repoRoot, cliEntry))) {
  const mod = await import(pathToFileURL(join(repoRoot, cliEntry)).href);
  const loader = mod.cloudBackendLoader;
  if (!loader) {
    fail(`${cliEntry} does not export \`cloudBackendLoader\` (the relay bin imports that name)`);
  } else {
    // hetzner is a plain REST backend — no heavy SDK import.
    const hetzner = await loader.resolveBackend('hetzner');
    if (typeof hetzner?.exec !== 'function') {
      fail(`${cliEntry}: resolveBackend('hetzner') did not return a CloudBackend`);
    }
    // docker has no cloud backend, and plugins must stay on the relay's own
    // registry path (the one place the SDK-version gate runs).
    if ((await loader.resolveBackend('docker')) !== null) {
      fail(`${cliEntry}: resolveBackend('docker') must return null`);
    }
    if ((await loader.resolveBackend('definitely-not-a-provider')) !== null) {
      fail(`${cliEntry}: resolveBackend() must return null for non-built-in names`);
    }
    const cp = await loader.loadCloudCp();
    if (typeof cp?.pullCloudDirContents !== 'function') {
      fail(`${cliEntry}: loadCloudCp() did not return the sandbox-cloud cp helpers`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('cloud-backend wiring is intact ✓');
