import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { AGENTBOX_BIN, E2E_PACK_DIR, E2E_PREFIX, REPO_ROOT } from './env.js';
import { progress } from './runner.js';

async function sh(cmd: string, args: string[], cwd: string, log: string): Promise<void> {
  const r = await execa(cmd, args, { cwd, reject: false, all: true, stdin: 'ignore' });
  appendFileSync(
    log,
    `\n$ ${cmd} ${args.join(' ')}\n${String(r.all ?? '')}\n[exit ${String(r.exitCode)}]\n`,
  );
  if (r.exitCode !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${String(r.exitCode)}); see ${log}`);
}

/**
 * Build what `npm publish` would ship and install it into the e2e prefix. `npm pack`
 * skips `prepublishOnly`, so the chain runs by hand; a bare `pnpm build` would ship a
 * stale staged hub bundle.
 */
export async function buildTarball(log: string): Promise<string> {
  mkdirSync(E2E_PACK_DIR, { recursive: true });
  progress('pack: pnpm -w build');
  await sh('pnpm', ['-w', 'build'], REPO_ROOT, log);
  progress('pack: hub build:standalone');
  await sh('pnpm', ['--filter', '@agentbox/hub', 'build:standalone'], REPO_ROOT, log);
  progress('pack: stage runtime');
  await sh('pnpm', ['--filter', '@madarco/agentbox', 'stage'], REPO_ROOT, log);
  for (const f of readdirSync(E2E_PACK_DIR)) if (f.endsWith('.tgz')) rmSync(join(E2E_PACK_DIR, f));
  progress('pack: npm pack');
  await sh(
    'npm',
    ['pack', '--silent', '--pack-destination', E2E_PACK_DIR],
    join(REPO_ROOT, 'apps', 'cli'),
    log,
  );
  return latestTarball();
}

export function latestTarball(): string {
  const tgz = existsSync(E2E_PACK_DIR)
    ? readdirSync(E2E_PACK_DIR)
        .filter((f) => f.endsWith('.tgz'))
        .map((f) => join(E2E_PACK_DIR, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  if (!tgz[0]) throw new Error(`no tarball in ${E2E_PACK_DIR}; run without --no-build`);
  return tgz[0];
}

export async function installTarball(tarball: string, log: string): Promise<string> {
  rmSync(E2E_PREFIX, { recursive: true, force: true });
  mkdirSync(E2E_PREFIX, { recursive: true });
  progress(`install: ${tarball}`);
  await sh(
    'npm',
    ['install', '-g', '--prefix', E2E_PREFIX, '--no-fund', '--no-audit', tarball],
    REPO_ROOT,
    log,
  );
  const r = await execa(AGENTBOX_BIN, ['--version'], { reject: false });
  const version = String(r.stdout).trim();
  const want = /agentbox-([^/]+)\.tgz$/.exec(tarball)?.[1];
  if (r.exitCode !== 0 || (want && version !== want)) {
    throw new Error(
      `installed CLI reports "${version}" (exit ${String(r.exitCode)}), tarball is ${want ?? '?'}`,
    );
  }
  return version;
}
