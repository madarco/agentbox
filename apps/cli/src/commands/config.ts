import { spawnSync } from 'node:child_process';
import {
  configPathFor,
  KEY_REGISTRY,
  loadEffectiveConfig,
  listProjectsConfigured,
  lookupKey,
  setConfigValue,
  unsetConfigValue,
  UserConfigError,
  type ConfigScope,
  type ConfigSource,
  type LoadedConfig,
} from '@agentbox/config';
import { Command, InvalidArgumentError } from 'commander';

type EditScope = ConfigScope | 'workspace';

interface ScopeOptions {
  global?: boolean;
  project?: boolean;
}

interface EditScopeOptions extends ScopeOptions {
  workspace?: boolean;
}

interface GetOptions {
  all?: boolean;
  json?: boolean;
}

interface SetOptions extends ScopeOptions {
  json?: boolean;
}

interface ListOptions {
  scope?: 'global' | 'project' | 'workspace' | 'effective';
  includeAdvanced?: boolean;
  json?: boolean;
}

interface PathOptions extends EditScopeOptions {
  json?: boolean;
}

interface ListProjectsOptions {
  json?: boolean;
}

function resolveWriteScope(opts: ScopeOptions): ConfigScope {
  if (opts.global && opts.project) {
    fail('pass at most one of --global / --project');
  }
  if (opts.global) return 'global';
  return 'project'; // default per spec
}

function resolveEditScope(opts: EditScopeOptions): EditScope {
  const flags = [opts.global, opts.project, opts.workspace].filter(Boolean).length;
  if (flags > 1) fail('pass at most one of --global / --project / --workspace');
  if (opts.workspace) return 'workspace';
  if (opts.global) return 'global';
  return 'project';
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function leafValue(loaded: LoadedConfig, key: string): unknown {
  const idx = key.indexOf('.');
  const branch = key.slice(0, idx);
  const leaf = key.slice(idx + 1);
  return (loaded.effective as unknown as Record<string, Record<string, unknown>>)[branch]?.[leaf];
}

function rawLeafFromValues(
  values: Record<string, unknown> | undefined,
  key: string,
): unknown {
  if (!values) return undefined;
  const idx = key.indexOf('.');
  const b = (values as Record<string, unknown>)[key.slice(0, idx)];
  if (!b || typeof b !== 'object') return undefined;
  return (b as Record<string, unknown>)[key.slice(idx + 1)];
}

function describeSource(source: ConfigSource, loaded: LoadedConfig): string {
  switch (source) {
    case 'cli':
      return 'cli flag';
    case 'workspace':
      return loaded.layers.workspace.path
        ? `workspace ${loaded.layers.workspace.path}`
        : 'workspace';
    case 'project':
      return `project ${loaded.layers.project.path}`;
    case 'global':
      return `global ${loaded.layers.global.path}`;
    case 'default':
      return 'built-in default';
  }
}

function fmtValue(v: unknown): string {
  if (v === undefined) return '<unset>';
  if (typeof v === 'string') return v;
  return String(v);
}

const getCommand = new Command('get')
  .description('Print the effective value of a config key (with --all, show every layer)')
  .argument('<key>', 'dot-path key (e.g. box.hostSnapshot)')
  .option('--all', 'print every layer with its source')
  .option('--json', 'machine-readable output')
  .action(async (key: string, opts: GetOptions) => {
    const desc = lookupKey(key);
    if (!desc) fail(`unknown key "${key}"`);

    try {
      const loaded = await loadEffectiveConfig(process.cwd());
      const value = leafValue(loaded, key);
      const source = loaded.sources[key] ?? 'default';

      if (opts.json) {
        const layerView = (
          values: Record<string, unknown> | undefined,
          path: string | null,
        ): { value: unknown; path: string | null } => ({
          value: rawLeafFromValues(values, key) ?? null,
          path,
        });
        process.stdout.write(
          JSON.stringify(
            {
              key,
              value: value ?? null,
              source,
              layers: opts.all
                ? {
                    cli: layerView(loaded.layers.cli.values as Record<string, unknown>, null),
                    workspace: layerView(
                      loaded.layers.workspace.values as Record<string, unknown>,
                      loaded.layers.workspace.path,
                    ),
                    project: layerView(
                      loaded.layers.project.values as Record<string, unknown>,
                      loaded.layers.project.path,
                    ),
                    global: layerView(
                      loaded.layers.global.values as Record<string, unknown>,
                      loaded.layers.global.path,
                    ),
                    default: { value: leafValue({ ...loaded, effective: loaded.layers.defaults } as LoadedConfig, key) ?? null, path: null },
                  }
                : undefined,
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }

      if (opts.all) {
        const lines = [
          `${key}:`,
          `  effective: ${fmtValue(value)}   (${describeSource(source, loaded)})`,
          `  cli:       ${fmtValue(rawLeafFromValues(loaded.layers.cli.values as Record<string, unknown>, key))}`,
          `  workspace: ${fmtValue(rawLeafFromValues(loaded.layers.workspace.values as Record<string, unknown>, key))}` +
            (loaded.layers.workspace.path ? `   ${loaded.layers.workspace.path}` : ''),
          `  project:   ${fmtValue(rawLeafFromValues(loaded.layers.project.values as Record<string, unknown>, key))}   ${loaded.layers.project.path}`,
          `  global:    ${fmtValue(rawLeafFromValues(loaded.layers.global.values as Record<string, unknown>, key))}   ${loaded.layers.global.path}`,
          `  default:   ${fmtValue(leafValue({ ...loaded, effective: loaded.layers.defaults } as LoadedConfig, key))}`,
        ];
        process.stdout.write(lines.join('\n') + '\n');
        return;
      }

      process.stdout.write(`${key} = ${fmtValue(value)}   (from: ${describeSource(source, loaded)})\n`);
    } catch (err) {
      handleError(err);
    }
  });

const setCommand = new Command('set')
  .description('Set a config key in the global or per-project file (default: --project)')
  .argument('<key>', 'dot-path key (e.g. box.hostSnapshot)')
  .argument('<value>', 'value to set; coerced to the key\'s declared type')
  .option('--global', "write to ~/.agentbox/config.yaml")
  .option('--project', 'write to ~/.agentbox/projects/<hash>/config.yaml (default)')
  .action(async (key: string, value: string, opts: SetOptions) => {
    const scope = resolveWriteScope(opts);
    try {
      const r = await setConfigValue(scope, key, value, process.cwd(), { raw: true });
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ key, scope, value: r.coerced, path: r.path }, null, 2) + '\n',
        );
      } else {
        process.stdout.write(`${key} = ${fmtValue(r.coerced)}   (wrote ${r.path})\n`);
        warnOnSet(key, r.coerced);
      }
    } catch (err) {
      handleError(err);
    }
  });

/**
 * Print key-specific caveats after a successful `config set`. Kept here (not in
 * the config package) because it's about CLI/runtime behavior, not the value's
 * validity.
 */
function warnOnSet(key: string, value: unknown): void {
  if (key === 'queue.openIn' && value !== 'none') {
    process.stderr.write(
      'note: queue.openIn only opens a terminal when you submit the `-i` job from inside tmux, cmux, or iTerm2.\n' +
        "      cmux: the box is opened by the relay's queue worker, a cmux-external process, so cmux's default\n" +
        '      `socketControlMode: cmuxOnly` blocks it. Set `socketControlMode` to `automation` (or `password`)\n' +
        '      in ~/.config/cmux/cmux.json and run `cmux reload-config` for cmux opens to work.\n',
    );
  }
}

const unsetCommand = new Command('unset')
  .description('Remove a config key from the global or per-project file (default: --project)')
  .argument('<key>', 'dot-path key (e.g. box.hostSnapshot)')
  .option('--global', "edit ~/.agentbox/config.yaml")
  .option('--project', 'edit ~/.agentbox/projects/<hash>/config.yaml (default)')
  .action(async (key: string, opts: ScopeOptions) => {
    const scope = resolveWriteScope(opts);
    try {
      const r = await unsetConfigValue(scope, key, process.cwd());
      if (r.existed) {
        process.stdout.write(`removed ${key} from ${r.path}\n`);
      } else {
        process.stdout.write(`${key} was not set in ${r.path}\n`);
      }
    } catch (err) {
      handleError(err);
    }
  });

function parseListScope(value: string): ListOptions['scope'] {
  if (value === 'global' || value === 'project' || value === 'workspace' || value === 'effective') {
    return value;
  }
  throw new InvalidArgumentError(`expected one of: global, project, workspace, effective`);
}

const listCommand = new Command('list')
  .description('List config values, either for a single layer or the merged effective view')
  .option(
    '--scope <s>',
    'one of: global, project, workspace, effective (default: effective)',
    parseListScope,
    'effective',
  )
  .option('--include-advanced', 'include advanced keys (image, ports)')
  .option('--json', 'machine-readable output')
  .action(async (opts: ListOptions) => {
    try {
      const loaded = await loadEffectiveConfig(process.cwd());
      const scope = opts.scope ?? 'effective';
      const showAdvanced = !!opts.includeAdvanced;
      const visibleKeys = KEY_REGISTRY.filter((d) => showAdvanced || !d.advanced);

      if (opts.json) {
        const obj: Record<string, unknown> = {};
        for (const desc of visibleKeys) {
          const value = pickFromScope(loaded, scope, desc.key);
          obj[desc.key] = scope === 'effective'
            ? { value: value ?? null, source: loaded.sources[desc.key] ?? 'default' }
            : { value: value ?? null };
        }
        process.stdout.write(JSON.stringify({ scope, keys: obj }, null, 2) + '\n');
        return;
      }

      if (scope === 'effective') {
        const lines: string[] = [];
        for (const desc of visibleKeys) {
          const value = leafValue(loaded, desc.key);
          const source = loaded.sources[desc.key] ?? 'default';
          lines.push(`${desc.key.padEnd(28)} ${fmtValue(value).padEnd(20)} (${source})`);
        }
        process.stdout.write(lines.join('\n') + '\n');
        return;
      }

      const layerPath =
        scope === 'global'
          ? loaded.layers.global.path
          : scope === 'project'
            ? loaded.layers.project.path
            : loaded.layers.workspace.path;
      process.stdout.write(`# ${scope} ${layerPath ?? '(no agentbox.yaml in ancestors)'}\n`);
      let any = false;
      for (const desc of visibleKeys) {
        const v = pickFromScope(loaded, scope, desc.key);
        if (v === undefined) continue;
        any = true;
        process.stdout.write(`${desc.key.padEnd(28)} ${fmtValue(v)}\n`);
      }
      if (!any) process.stdout.write('(no values set in this scope)\n');
    } catch (err) {
      handleError(err);
    }
  });

function pickFromScope(loaded: LoadedConfig, scope: ListOptions['scope'], key: string): unknown {
  switch (scope) {
    case 'global':
      return rawLeafFromValues(loaded.layers.global.values as Record<string, unknown>, key);
    case 'project':
      return rawLeafFromValues(loaded.layers.project.values as Record<string, unknown>, key);
    case 'workspace':
      return rawLeafFromValues(loaded.layers.workspace.values as Record<string, unknown>, key);
    case 'effective':
    default:
      return leafValue(loaded, key);
  }
}

const pathCommand = new Command('path')
  .description('Print the file path for a config scope (default: --project)')
  .option('--global', "~/.agentbox/config.yaml")
  .option('--project', '~/.agentbox/projects/<hash>/config.yaml (default)')
  .option('--workspace', './agentbox.yaml (resolved by walking up to the nearest one)')
  .option('--json', 'machine-readable output')
  .action(async (opts: PathOptions) => {
    try {
      const scope = resolveEditScope(opts);
      const path = await configPathFor(scope, process.cwd());
      if (opts.json) process.stdout.write(JSON.stringify({ scope, path }, null, 2) + '\n');
      else process.stdout.write(`${path}\n`);
    } catch (err) {
      handleError(err);
    }
  });

const editCommand = new Command('edit')
  .description('Open a config file in $EDITOR (default: --project)')
  .option('--global', 'edit ~/.agentbox/config.yaml')
  .option('--project', 'edit ~/.agentbox/projects/<hash>/config.yaml (default)')
  .option('--workspace', "edit ./agentbox.yaml (the resolved one — and remember to fill in the `defaults:` block)")
  .action(async (opts: EditScopeOptions) => {
    try {
      const scope = resolveEditScope(opts);
      const path = await configPathFor(scope, process.cwd());
      const editor = process.env['EDITOR'] || process.env['VISUAL'] || 'vi';
      const child = spawnSync(editor, [path], { stdio: 'inherit' });
      process.exit(child.status ?? 0);
    } catch (err) {
      handleError(err);
    }
  });

const listProjectsCommand = new Command('list-projects')
  .description('List directories that have per-user-per-project config recorded under ~/.agentbox/projects/')
  .option('--json', 'machine-readable output')
  .action(async (opts: ListProjectsOptions) => {
    try {
      const projects = await listProjectsConfigured();
      if (opts.json) {
        process.stdout.write(JSON.stringify(projects, null, 2) + '\n');
        return;
      }
      if (projects.length === 0) {
        process.stdout.write('(no per-project config recorded)\n');
        return;
      }
      for (const p of projects) {
        process.stdout.write(
          `${p.hash}  ${p.originalPath}${p.hasConfigFile ? '' : '  (meta only — no config.yaml)'}\n`,
        );
      }
    } catch (err) {
      handleError(err);
    }
  });

function handleError(err: unknown): never {
  if (err instanceof UserConfigError) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

export const configCommand = new Command('config')
  .description('Read / write layered config (global, per-project, workspace `defaults:` block)')
  .addCommand(getCommand)
  .addCommand(setCommand)
  .addCommand(unsetCommand)
  .addCommand(listCommand)
  .addCommand(pathCommand)
  .addCommand(editCommand)
  .addCommand(listProjectsCommand);
