/**
 * The impure half of the provider-plugin refresh: read the registry, work out
 * how each package was installed, ask the npm registry what it publishes, then
 * hand all of it to `decidePluginUpdates` and carry out what it says.
 *
 * Runs from the FRESHLY INSTALLED binary (`_post-update-refresh`), never from
 * the one being replaced: `SUPPORTED_SDK_API_VERSIONS` is compiled in, so the
 * old binary would pick a plugin build for the OLD gate and strand the user
 * under the new one — the exact failure this feature exists to prevent.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadEffectiveConfig } from '@agentbox/config';
import {
  readPluginRegistrySync,
  resolveCliEntry,
  SUPPORTED_SDK_API_VERSIONS,
} from '@agentbox/sandbox-core';
import { resolvePackage } from '../commands/plugin.js';
import { DEFAULT_NPM_REGISTRY, fetchPluginPackument } from './npm-packument.js';
import { classifyPluginInstall, readGlobalRoots } from './plugin-install-root.js';
import {
  decidePluginUpdates,
  describePluginUpdate,
  type PluginUpdateCandidate,
  type PluginUpdateOutcome,
} from './plugin-update-decision.js';

export interface PluginUpdateReport {
  outcomes: PluginUpdateOutcome[];
  /** Packages actually reinstalled and re-registered. */
  updated: { packageName: string; from: string; to: string }[];
  /** Human-readable problems; the caller logs them as warnings. */
  problems: string[];
}

async function npmRegistry(): Promise<string> {
  try {
    const cfg = await loadEffectiveConfig(process.cwd());
    return cfg.effective.update.registry || DEFAULT_NPM_REGISTRY;
  } catch {
    return DEFAULT_NPM_REGISTRY;
  }
}

/**
 * One candidate per registered plugin.
 *
 * The stored `resolvedEntry` is the primary signal, because it is what
 * `loadProviderModule` actually imports — so it, not the package name, is what
 * "this plugin" means. Re-resolving by name first would find a same-named
 * GLOBAL install and quietly reclassify a path-registered plugin as updatable,
 * which is how a local checkout gets overwritten.
 *
 * Re-resolution is the fallback for when that path is gone: under nvm
 * `npm root -g` is node-version-specific, so a record written under another node
 * points into a root this one cannot see. If neither resolves, the plugin is
 * `missing` rather than silently a local path.
 */
export async function collectPluginCandidates(opts: {
  registryPath?: string;
  registry?: string;
  only?: string;
}): Promise<PluginUpdateCandidate[]> {
  const { plugins } = readPluginRegistrySync(opts.registryPath);
  const wanted = opts.only;
  const selected = wanted
    ? plugins.filter((p) => p.packageName === wanted || p.providers.includes(wanted))
    : plugins;
  const roots = readGlobalRoots();
  const registry = opts.registry ?? (await npmRegistry());

  return Promise.all(
    selected.map(async (rec) => {
      let resolvedEntry: string | null = existsSync(rec.resolvedEntry) ? rec.resolvedEntry : null;
      if (resolvedEntry === null) {
        try {
          resolvedEntry = resolvePackage(rec.packageName).entryPath;
        } catch {
          resolvedEntry = null;
        }
      }
      const install = classifyPluginInstall({
        packageName: rec.packageName,
        resolvedEntry,
        roots,
      });
      // Don't spend a network round trip on a package we are not allowed to
      // touch anyway. `[]` (registry answered, no such package) and `undefined`
      // (could not reach it) are deliberately different inputs downstream.
      let published: PluginUpdateCandidate['published'];
      if (install.kind === 'npm' || install.kind === 'pnpm') {
        const res = await fetchPluginPackument(rec.packageName, { registry });
        published = res.ok ? res.packument.versions : res.reason === 'not-found' ? [] : undefined;
      }
      return {
        packageName: rec.packageName,
        installedVersion: rec.version,
        installedApiVersion: rec.apiVersion,
        install,
        published,
      };
    }),
  );
}

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function installArgs(
  manager: 'npm' | 'pnpm',
  pkg: string,
  version: string,
): { cmd: string; args: string[] } {
  return manager === 'pnpm'
    ? { cmd: 'pnpm', args: ['add', '-g', `${pkg}@${version}`] }
    : { cmd: 'npm', args: ['install', '-g', `${pkg}@${version}`] };
}

export async function runPluginUpdates(opts: {
  skip?: boolean;
  dryRun?: boolean;
  only?: string;
  registryPath?: string;
  registry?: string;
  log?: (line: string) => void;
}): Promise<PluginUpdateReport> {
  const log = opts.log ?? (() => {});
  const report: PluginUpdateReport = { outcomes: [], updated: [], problems: [] };

  const candidates = await collectPluginCandidates({
    registryPath: opts.registryPath,
    registry: opts.registry,
    only: opts.only,
  });
  if (candidates.length === 0) return report;

  report.outcomes = decidePluginUpdates({
    candidates,
    supportedMajors: SUPPORTED_SDK_API_VERSIONS,
    skipFlag: opts.skip === true,
  });

  for (const outcome of report.outcomes) log(describePluginUpdate(outcome));
  if (opts.dryRun === true || opts.skip === true) return report;

  const entry = resolveCliEntry();

  for (const outcome of report.outcomes) {
    if (outcome.action !== 'update') continue;
    // Per-package isolation: one plugin that fails to install or re-validate
    // must not stop the next one.
    try {
      const { cmd, args } = installArgs(outcome.manager, outcome.packageName, outcome.to);
      const code = await run(cmd, args);
      if (code !== 0) {
        // Naming the exact command matters: the usual cause is a global prefix
        // the user cannot write to, which they fix by re-running it themselves.
        report.problems.push(
          `${outcome.packageName} was not updated (\`${cmd} ${args.join(' ')}\` exited ${String(code)}) — the previously registered build is untouched`,
        );
        continue;
      }

      // Re-register in a CHILD process, not in-process. The global install path
      // is stable, so a second `import()` here returns the CACHED old module —
      // and a cache-busting query would double-instantiate a module graph
      // holding SDK singletons and credential state. A child also contains a
      // plugin whose top-level code calls process.exit().
      if (entry === null) {
        report.problems.push(
          `${outcome.packageName} was updated to ${outcome.to} but could not be re-registered (no CLI entry found) — run \`agentbox plugin add ${outcome.packageName}\``,
        );
        continue;
      }
      const regCode = await run(process.execPath, [
        entry,
        'plugin',
        'add',
        outcome.packageName,
        '--yes',
        '--quiet',
      ]);
      if (regCode !== 0) {
        // Deliberately NOT rolled back: `npm i -g` already replaced the contents
        // of the directory `resolvedEntry` points at, so reverting the JSON
        // would describe code that no longer exists. The stale record is
        // refused with a clear message at load, and `plugin list` marks it.
        report.problems.push(
          `${outcome.packageName} was updated to ${outcome.to} but failed to re-register — run \`agentbox plugin add ${outcome.packageName}\`, or \`${installArgs(outcome.manager, outcome.packageName, outcome.from).cmd} ${installArgs(outcome.manager, outcome.packageName, outcome.from).args.join(' ')}\` to go back`,
        );
        continue;
      }
      report.updated.push({
        packageName: outcome.packageName,
        from: outcome.from,
        to: outcome.to,
      });
    } catch (err) {
      report.problems.push(
        `${outcome.packageName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return report;
}
