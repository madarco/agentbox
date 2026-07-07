/**
 * Isolated publish smoke test for @madarco/agentbox-provider-sdk.
 *
 * A `file:`/workspace link can't catch a broken *published artifact* — a file
 * missing from `files`, or a `.d.ts`/runtime export that didn't ship. This packs
 * the package exactly as `npm publish` would, installs the tarball into a throwaway
 * dir with plain npm, imports it from there, and asserts the critical exports the
 * example plugin depends on actually resolve.
 *
 * Run: `pnpm --filter @madarco/agentbox-provider-sdk pack:test`
 * Exits non-zero (with the missing names) on any failure.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const PKG_NAME = '@madarco/agentbox-provider-sdk';
const PKG_DIR = resolve(fileURLToPath(import.meta.url), '..', '..');

// The surface a real provider plugin (see examples/agentbox-provider-example)
// imports. If any of these stops being exported, a published plugin breaks.
const REQUIRED_EXPORTS = [
  'SDK_API_VERSION',
  'createCloudProvider',
  'makeMockCloudBackend',
  'resolveSharedRuntimeAsset',
  'sharedRuntimeDir',
  // prepared-state primitives
  'computeContextSha256',
  'readCliStamp',
  'preparedStatePathFor',
  'readPreparedStateRaw',
  'writePreparedStateRaw',
  'claudeInstallFingerprint',
  // box-state helpers
  'recordBox',
  'readState',
  // attach helpers
  'renderInnerCommand',
  'hostTermForCloud',
  // prepare-time agent-config staging
  'stageClaudeStaticForUpload',
  'stageCodexStaticForUpload',
  'stageOpencodeStaticForUpload',
  // cloud checkpoint authoring (id-addressed snapshots)
  'writeCloudCheckpointManifest',
  'listCloudCheckpoints',
  'resolveCloudCheckpoint',
  'removeCloudCheckpointDir',
  'currentCloudBaseFingerprint',
  // errors
  'UserFacingError',
  'BoxNotFoundError',
];

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

const tmp = mkdtempSync(join(tmpdir(), 'agentbox-sdk-packtest-'));
let failed = false;
try {
  console.log(`[pack-test] building ${PKG_NAME}`);
  run('pnpm', ['build'], PKG_DIR);

  console.log('[pack-test] npm pack → tarball');
  const packed = run('npm', ['pack', '--pack-destination', tmp, '--json'], PKG_DIR);
  const tgzName = JSON.parse(packed)[0].filename;
  const tgz = join(tmp, tgzName);
  if (!existsSync(tgz)) throw new Error(`packed tarball not found at ${tgz}`);
  console.log(`[pack-test] packed ${tgzName}`);

  // A throwaway consumer that installs ONLY the tarball (so we exercise its
  // declared runtime deps + shipped files, nothing from the workspace).
  const consumer = join(tmp, 'consumer');
  execFileSync('mkdir', ['-p', consumer]);
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'packtest-consumer', private: true, version: '1.0.0' }, null, 2),
  );
  console.log('[pack-test] installing the tarball in isolation');
  run('npm', ['install', '--no-audit', '--no-fund', tgz], consumer);

  const entry = join(consumer, 'node_modules', PKG_NAME, 'dist', 'index.js');
  if (!existsSync(entry)) throw new Error(`dist entry missing from the published tarball: ${entry}`);
  const dts = join(consumer, 'node_modules', PKG_NAME, 'dist', 'index.d.ts');
  if (!existsSync(dts)) throw new Error(`types (index.d.ts) missing from the published tarball: ${dts}`);

  console.log('[pack-test] importing the installed package + checking exports');
  const mod = await import(pathToFileURL(entry).href);
  const missing = REQUIRED_EXPORTS.filter((name) => mod[name] === undefined);
  if (missing.length > 0) {
    failed = true;
    console.error(`[pack-test] FAIL — missing exports: ${missing.join(', ')}`);
  } else if (mod.SDK_API_VERSION !== 1) {
    failed = true;
    console.error(`[pack-test] FAIL — unexpected SDK_API_VERSION: ${String(mod.SDK_API_VERSION)}`);
  } else {
    console.log(`[pack-test] OK — ${REQUIRED_EXPORTS.length} exports present, SDK_API_VERSION=1`);
  }
} catch (err) {
  failed = true;
  console.error(`[pack-test] ERROR: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
