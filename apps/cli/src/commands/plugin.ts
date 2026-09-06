/**
 * `agentbox plugin` — manage externally-installed provider packages.
 *
 * A community provider ships as its own npm package (`agentbox-provider-<name>`)
 * built against `@madarco/agentbox-provider-sdk`. The user installs it themselves
 * (`npm i -g agentbox-provider-foo`, or into any resolvable location), then
 * `agentbox plugin add <pkg>` validates it and records it in
 * `~/.agentbox/plugins.json`. The CLI + relay resolve it from there at runtime.
 *
 * Trust: a plugin runs IN-PROCESS with full host + credential access. `add` is
 * the consent boundary — it names the package and warns before recording.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { confirm, log } from '@agentbox/cli-kit';
import {
  addPluginRecord,
  deriveDescriptor,
  isSupportedApiVersion,
  readPluginRegistrySync,
  removePluginRecord,
  SUPPORTED_SDK_API_VERSIONS,
  type PluginRecord,
  type ProviderModule,
} from '@agentbox/sandbox-core';
import { PROVIDER_NAMES, type ProviderDescriptor } from '@agentbox/config';

interface ResolvedPackage {
  packageName: string;
  version: string;
  /** Absolute path to the ESM entry to `import()`. */
  entryPath: string;
  agentboxApiVersion?: number;
}

/** Candidate base dirs to resolve a bare package name from (global + local + CLI). */
function resolutionPaths(): string[] {
  const paths = new Set<string>();
  paths.add(process.cwd());
  try {
    const g = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    if (g) paths.add(g);
  } catch {
    // npm not on PATH / offline — fall through to the other candidates.
  }
  for (const p of (process.env.NODE_PATH ?? '').split(':')) if (p) paths.add(p);
  return [...paths];
}

/**
 * Resolve `arg` (a package name OR a filesystem path) to its package.json +
 * ESM entry. For a bare name we locate `<name>/package.json` on disk from the
 * global install root / cwd / NODE_PATH, then read the entry from `exports`/`main`.
 *
 * Exported for tests.
 */
export function resolvePackage(arg: string): ResolvedPackage {
  let pkgDir: string;
  if ((arg.startsWith('.') || arg.startsWith('/') || isAbsolute(arg)) && existsSync(arg)) {
    pkgDir = statSync(arg).isDirectory() ? resolve(arg) : dirname(resolve(arg));
  } else {
    // Locate `<name>/package.json` on disk rather than via Node's conditional
    // resolver: a provider package legitimately ships ESM-only exports
    // (`exports: { ".": { "import": ... } }`), which `createRequire().resolve`
    // (CJS conditions) can't reach — and `<name>/package.json` isn't an
    // exported subpath anyway, so it throws ERR_PACKAGE_PATH_NOT_EXPORTED. We
    // only need the directory; the entry is picked from `exports` below.
    let pkgJsonPath: string | undefined;
    for (const base of resolutionPaths()) {
      for (const candidate of [
        resolve(base, arg, 'package.json'),
        resolve(base, 'node_modules', arg, 'package.json'),
      ]) {
        if (existsSync(candidate)) {
          pkgJsonPath = candidate;
          break;
        }
      }
      if (pkgJsonPath) break;
    }
    if (!pkgJsonPath) {
      throw new Error(
        `cannot resolve package "${arg}" — install it first (e.g. \`npm i -g ${arg}\`), or pass a path to its directory`,
      );
    }
    pkgDir = dirname(pkgJsonPath);
  }

  const pkgJson = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8')) as {
    name?: string;
    version?: string;
    main?: string;
    module?: string;
    exports?: unknown;
    agentbox?: { providerApiVersion?: number };
  };

  const entryRel = pickEntry(pkgJson);
  return {
    packageName: pkgJson.name ?? arg,
    version: pkgJson.version ?? '0.0.0',
    entryPath: resolve(pkgDir, entryRel),
    agentboxApiVersion: pkgJson.agentbox?.providerApiVersion,
  };
}

/** Pull the ESM entry from `exports['.'].import` / `module` / `main`. */
function pickEntry(pkgJson: { main?: string; module?: string; exports?: unknown }): string {
  const exp = pkgJson.exports;
  if (exp && typeof exp === 'object') {
    const dot = (exp as Record<string, unknown>)['.'] ?? exp;
    if (typeof dot === 'string') return dot;
    if (dot && typeof dot === 'object') {
      const cond = dot as Record<string, unknown>;
      const hit = cond['import'] ?? cond['default'] ?? cond['node'];
      if (typeof hit === 'string') return hit;
    }
  }
  return pkgJson.module ?? pkgJson.main ?? 'index.js';
}

interface LoadedProvider {
  name: string;
  hasBackend: boolean;
  /**
   * What the module declares, else what could be derived from it. Snapshotted
   * into the registry so every later consumer resolves capabilities without
   * re-importing an external package.
   */
  descriptor: ProviderDescriptor;
}

/** Import the resolved package and validate it exposes provider module(s). */
async function loadAndValidate(
  pkg: ResolvedPackage,
): Promise<{ providers: LoadedProvider[]; apiVersion: number }> {
  const mod = (await import(pathToFileURL(pkg.entryPath).href)) as {
    providerModule?: ProviderModule;
    providerModules?: ProviderModule[];
    SDK_API_VERSION?: number;
    apiVersion?: number;
  };
  const all = mod.providerModules ?? (mod.providerModule ? [mod.providerModule] : []);
  if (all.length === 0) {
    throw new Error(
      `package "${pkg.packageName}" does not export a \`providerModule\` (or \`providerModules\`) — it is not an AgentBox provider plugin`,
    );
  }
  const providers: LoadedProvider[] = [];
  for (const pm of all) {
    const name = pm.provider?.name;
    if (!name || typeof name !== 'string') {
      throw new Error(
        `package "${pkg.packageName}" has a providerModule with no \`provider.name\``,
      );
    }
    if ((PROVIDER_NAMES as readonly string[]).includes(name)) {
      throw new Error(
        `package "${pkg.packageName}" tries to register provider "${name}", which is a built-in — a plugin cannot shadow a built-in provider`,
      );
    }
    providers.push({
      name,
      hasBackend: Boolean(pm.backend),
      descriptor: deriveDescriptor(name, pm),
    });
  }
  const apiVersion = pkg.agentboxApiVersion ?? mod.apiVersion ?? mod.SDK_API_VERSION ?? 1;
  if (!isSupportedApiVersion(apiVersion)) {
    throw new Error(
      `package "${pkg.packageName}" targets provider SDK v${String(apiVersion)}; this AgentBox supports v${SUPPORTED_SDK_API_VERSIONS.join(', v')}`,
    );
  }
  return { providers, apiVersion };
}

/** A package resolved, imported and validated — everything but the registry write. */
export interface InspectedPlugin {
  packageName: string;
  version: string;
  entryPath: string;
  providers: LoadedProvider[];
  apiVersion: number;
}

/**
 * Resolve + import + validate. Throws with the same messages `plugin add` has
 * always printed. No registry I/O and no prompting, so the refresh path and the
 * interactive command share one implementation of "is this package usable".
 */
export async function inspectPluginPackage(arg: string): Promise<InspectedPlugin> {
  const pkg = resolvePackage(arg);
  const { providers, apiVersion } = await loadAndValidate(pkg);
  return {
    packageName: pkg.packageName,
    version: pkg.version,
    entryPath: pkg.entryPath,
    providers,
    apiVersion,
  };
}

/**
 * Collision check + registry write. `addPluginRecord` is an upsert keyed by
 * package name, so this doubles as the refresh for an already-registered
 * package whose on-disk version changed.
 */
export async function recordInspectedPlugin(
  p: InspectedPlugin,
  registryPath?: string,
): Promise<void> {
  // Reject a provider-name collision with a DIFFERENT already-registered
  // package (re-adding the same package is an allowed upsert). Otherwise the
  // registry would hold two entries for one name and only the first would
  // ever resolve.
  const existing = readPluginRegistrySync(registryPath).plugins;
  for (const prov of p.providers) {
    const clash = existing.find(
      (r) => r.packageName !== p.packageName && r.providers.includes(prov.name),
    );
    if (clash) {
      throw new Error(
        `provider "${prov.name}" is already provided by "${clash.packageName}" — remove it first (\`agentbox plugin remove ${prov.name}\`)`,
      );
    }
  }
  await addPluginRecord(
    {
      packageName: p.packageName,
      resolvedEntry: p.entryPath,
      version: p.version,
      providers: p.providers.map((x) => x.name),
      descriptors: Object.fromEntries(p.providers.map((x) => [x.name, x.descriptor])),
      apiVersion: p.apiVersion,
      addedAt: new Date().toISOString(),
    },
    registryPath,
  );
}

/** Non-interactive register/refresh — what `plugin add --yes` performs. */
export async function registerPluginPackage(
  arg: string,
  registryPath?: string,
): Promise<InspectedPlugin> {
  const inspected = await inspectPluginPackage(arg);
  await recordInspectedPlugin(inspected, registryPath);
  return inspected;
}

/**
 * A `plugin list` row. The three-column gutter keeps the provider column aligned
 * whether or not the row is marked, so `!` is greppable (`plugin list | grep '^!'`)
 * without the marked rows shifting out of line with the rest.
 */
export function renderPluginRow(rec: PluginRecord, supported: readonly number[]): string {
  const providers = rec.providers.join(', ').padEnd(20);
  const pkg = `${rec.packageName}@${rec.version}`;
  if (supported.includes(rec.apiVersion)) {
    return `   ${providers} ${pkg} (SDK v${String(rec.apiVersion)})\n`;
  }
  // Name the supported set from the constant rather than a literal, so the text
  // stays correct if the gate ever widens back to accepting several majors.
  const needs = supported.map((v) => `v${String(v)}`).join('/');
  return `!  ${providers} ${pkg} (SDK v${String(rec.apiVersion)} — unsupported, this build needs ${needs})\n`;
}

/** Legend for `plugin list`, or null when every registered plugin is loadable. */
export function pluginListFooter(
  recs: readonly PluginRecord[],
  supported: readonly number[],
): string | null {
  if (!recs.some((r) => !supported.includes(r.apiVersion))) return null;
  // Indented into the same gutter as the rows on purpose: a footer starting with
  // a column-0 `!` would be counted by `plugin list | grep -c '^!'`, which is the
  // one-line health check the marker exists to enable.
  return (
    '\n   ! = built for an unsupported provider SDK and will not load — run `agentbox self-update` ' +
    '(it updates plugins too), or `agentbox plugin remove <name>`\n'
  );
}

export const pluginCommand = new Command('plugin').description(
  'Manage externally-installed provider packages (community providers)',
);

pluginCommand
  .command('add')
  .argument('<package>', 'installed package name or a path to its directory')
  .option('-y, --yes', 'skip the trust confirmation prompt')
  // Hidden: this exists so `self-update`'s plugin refresh, which spawns this
  // command, can print one tidy line of its own instead of clack chrome.
  .option('--quiet', 'suppress progress output (used by the self-update refresh)', false)
  .description('register an installed provider package so `--provider <name>` can use it')
  .action(async (packageArg: string, opts: { yes?: boolean; quiet?: boolean }) => {
    let inspected: InspectedPlugin;
    try {
      inspected = await inspectPluginPackage(packageArg);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }

    const provNames = inspected.providers.map((p) => p.name).join(', ');
    if (!opts.quiet) {
      log.info(
        `${inspected.packageName}@${inspected.version} — provider(s): ${provNames} (SDK v${String(inspected.apiVersion)})`,
      );
    }
    if (!opts.yes) {
      log.warn(
        'A provider plugin runs as trusted code inside AgentBox — it can read your cloud credentials and run commands on your host. Only add plugins you trust.',
      );
      const ok = await confirm({ message: `Add "${inspected.packageName}"?`, initialValue: false });
      if (!ok) {
        log.info('aborted');
        return;
      }
    }

    try {
      await recordInspectedPlugin(inspected);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    if (!opts.quiet) {
      log.success(
        `registered ${inspected.packageName} — now usable via \`--provider ${provNames}\``,
      );
    }
  });

pluginCommand
  .command('list')
  .description('list registered provider plugins')
  .action(() => {
    const { plugins } = readPluginRegistrySync();
    if (plugins.length === 0) {
      process.stdout.write('no provider plugins registered\n');
      return;
    }
    for (const p of plugins) {
      process.stdout.write(renderPluginRow(p, SUPPORTED_SDK_API_VERSIONS));
    }
    const footer = pluginListFooter(plugins, SUPPORTED_SDK_API_VERSIONS);
    if (footer) process.stdout.write(footer);
  });

pluginCommand
  .command('info')
  .argument('<name>', 'provider name or package name')
  .description('show a registered plugin')
  .action((name: string) => {
    const { plugins } = readPluginRegistrySync();
    const hit = plugins.find((p) => p.packageName === name || p.providers.includes(name));
    if (!hit) {
      process.stderr.write(`no registered plugin matches "${name}"\n`);
      process.exitCode = 1;
      return;
    }
    // stderr, not a synthetic key in the JSON: `plugin info x | jq` has to keep
    // working, and the command's contract is "show the record" as it is stored.
    if (!isSupportedApiVersion(hit.apiVersion)) {
      process.stderr.write(
        `! ${hit.packageName} targets provider SDK v${String(hit.apiVersion)}; this build supports v${SUPPORTED_SDK_API_VERSIONS.join(', v')} — it will not load\n`,
      );
    }
    process.stdout.write(JSON.stringify(hit, null, 2) + '\n');
  });

pluginCommand
  .command('update')
  .argument('[name]', 'provider or package name to update (default: all registered plugins)')
  .option('--dry-run', 'show what would change without installing anything', false)
  .option('-y, --yes', 'accepted for symmetry with `add`; this command never prompts', false)
  .description('update registered provider plugins to their newest SDK-compatible release')
  .action(async (name: string | undefined, opts: { dryRun?: boolean }) => {
    // The enumerating dry-run `self-update` cannot offer: its plan block is
    // printed by the OLD binary, whose gate is the one being replaced.
    const { runPluginUpdates } = await import('../lib/plugin-update.js');
    const report = await runPluginUpdates({
      dryRun: opts.dryRun === true,
      ...(name === undefined ? {} : { only: name }),
      log: (line) => log.info(line),
    });
    if (report.outcomes.length === 0) {
      log.info(
        name === undefined
          ? 'no provider plugins registered'
          : `no registered plugin matches "${name}"`,
      );
      return;
    }
    for (const problem of report.problems) log.warn(problem);
    if (report.updated.length > 0) {
      log.success(`updated ${String(report.updated.length)} plugin(s)`);
    }
    if (report.problems.length > 0) process.exitCode = 1;
  });

pluginCommand
  .command('remove')
  .alias('rm')
  .argument('<name>', 'provider name or package name to unregister')
  .description('unregister a provider plugin (does not uninstall the npm package)')
  .action(async (name: string) => {
    const removed = await removePluginRecord(name);
    if (removed === 0) {
      process.stderr.write(`no registered plugin matched "${name}"\n`);
      process.exitCode = 1;
      return;
    }
    log.success(`unregistered ${String(removed)} plugin record(s) matching "${name}"`);
  });
