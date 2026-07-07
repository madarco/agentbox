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
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { confirm, log } from '../lib/prompt.js';
import {
  addPluginRecord,
  isSupportedApiVersion,
  readPluginRegistrySync,
  removePluginRecord,
  SUPPORTED_SDK_API_VERSIONS,
} from '@agentbox/sandbox-core';
import { PROVIDER_NAMES } from '@agentbox/config';

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
 * ESM entry. For a bare name we resolve `<name>/package.json` from the global
 * install root / cwd / NODE_PATH, then read the entry from `exports`/`main`.
 */
function resolvePackage(arg: string): ResolvedPackage {
  let pkgDir: string;
  if ((arg.startsWith('.') || arg.startsWith('/') || isAbsolute(arg)) && existsSync(arg)) {
    pkgDir = statSync(arg).isDirectory() ? resolve(arg) : dirname(resolve(arg));
  } else {
    const req = createRequire(pathToFileURL(resolve(process.cwd(), 'noop.js')).href);
    let pkgJsonPath: string | undefined;
    for (const base of resolutionPaths()) {
      try {
        pkgJsonPath = req.resolve(`${arg}/package.json`, {
          paths: [base, resolve(base, 'node_modules')],
        });
        break;
      } catch {
        // try the next base
      }
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
}

/** Import the resolved package and validate it exposes provider module(s). */
async function loadAndValidate(
  pkg: ResolvedPackage,
): Promise<{ providers: LoadedProvider[]; apiVersion: number }> {
  const mod = (await import(pathToFileURL(pkg.entryPath).href)) as {
    providerModule?: { provider?: { name?: string }; backend?: unknown };
    providerModules?: { provider?: { name?: string }; backend?: unknown }[];
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
      throw new Error(`package "${pkg.packageName}" has a providerModule with no \`provider.name\``);
    }
    if ((PROVIDER_NAMES as readonly string[]).includes(name)) {
      throw new Error(
        `package "${pkg.packageName}" tries to register provider "${name}", which is a built-in — a plugin cannot shadow a built-in provider`,
      );
    }
    providers.push({ name, hasBackend: Boolean(pm.backend) });
  }
  const apiVersion = pkg.agentboxApiVersion ?? mod.apiVersion ?? mod.SDK_API_VERSION ?? 1;
  if (!isSupportedApiVersion(apiVersion)) {
    throw new Error(
      `package "${pkg.packageName}" targets provider SDK v${String(apiVersion)}; this AgentBox supports v${SUPPORTED_SDK_API_VERSIONS.join(', v')}`,
    );
  }
  return { providers, apiVersion };
}

export const pluginCommand = new Command('plugin').description(
  'Manage externally-installed provider packages (community providers)',
);

pluginCommand
  .command('add')
  .argument('<package>', 'installed package name or a path to its directory')
  .option('-y, --yes', 'skip the trust confirmation prompt')
  .description('register an installed provider package so `--provider <name>` can use it')
  .action(async (packageArg: string, opts: { yes?: boolean }) => {
    let pkg: ResolvedPackage;
    let validated: { providers: LoadedProvider[]; apiVersion: number };
    try {
      pkg = resolvePackage(packageArg);
      validated = await loadAndValidate(pkg);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }

    // Reject a provider-name collision with a DIFFERENT already-registered
    // package (re-adding the same package is an allowed upsert). Otherwise the
    // registry would hold two entries for one name and only the first would
    // ever resolve.
    const existing = readPluginRegistrySync().plugins;
    for (const p of validated.providers) {
      const clash = existing.find(
        (r) => r.packageName !== pkg.packageName && r.providers.includes(p.name),
      );
      if (clash) {
        log.error(
          `provider "${p.name}" is already provided by "${clash.packageName}" — remove it first (\`agentbox plugin remove ${p.name}\`)`,
        );
        process.exitCode = 1;
        return;
      }
    }

    const provNames = validated.providers.map((p) => p.name).join(', ');
    log.info(
      `${pkg.packageName}@${pkg.version} — provider(s): ${provNames} (SDK v${String(validated.apiVersion)})`,
    );
    if (!opts.yes) {
      log.warn(
        'A provider plugin runs as trusted code inside AgentBox — it can read your cloud credentials and run commands on your host. Only add plugins you trust.',
      );
      const ok = await confirm({ message: `Add "${pkg.packageName}"?`, initialValue: false });
      if (!ok) {
        log.info('aborted');
        return;
      }
    }

    await addPluginRecord({
      packageName: pkg.packageName,
      resolvedEntry: pkg.entryPath,
      version: pkg.version,
      providers: validated.providers.map((p) => p.name),
      apiVersion: validated.apiVersion,
      addedAt: new Date().toISOString(),
    });
    log.success(`registered ${pkg.packageName} — now usable via \`--provider ${provNames}\``);
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
      process.stdout.write(
        `${p.providers.join(', ').padEnd(20)} ${p.packageName}@${p.version} (SDK v${String(p.apiVersion)})\n`,
      );
    }
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
    process.stdout.write(JSON.stringify(hit, null, 2) + '\n');
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
