import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import {
  findProjectRoot,
  GLOBAL_CONFIG_FILE,
  hashProjectPath,
  projectConfigFile,
  workspaceConfigFile,
} from './paths.js';
import { parseUserConfig, parseUserConfigObject } from './parse.js';
import {
  BUILT_IN_DEFAULTS,
  type ConfigSource,
  type EffectiveConfig,
  KEY_REGISTRY,
  type LoadedConfig,
  type UserConfig,
} from './types.js';

/**
 * Process-wide sink for non-fatal config warnings (unknown keys). Registered by
 * the CLI so every `loadEffectiveConfig` call surfaces them without threading a
 * logger through ~84 call sites.
 *
 * A provider plugin bundles its own copy of this module (the SDK inlines
 * `@agentbox/config`) and registers NO sink — so a stale plugin silently
 * tolerates keys it hasn't heard of, while the host CLI still tells the user.
 */
let warningSink: ((message: string) => void) | null = null;

export function setConfigWarningSink(fn: ((message: string) => void) | null): void {
  warningSink = fn;
}

function collectWarning(into: string[], message: string): void {
  into.push(message);
  warningSink?.(message);
}

/**
 * ENOENT-tolerant read of a UserConfig file. Anything else propagates.
 */
async function loadOptionalUserConfig(
  path: string,
  warnings: string[],
): Promise<Partial<UserConfig>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  return parseUserConfig(text, path, { onWarning: (m) => collectWarning(warnings, m) });
}

/**
 * Read the `defaults:` block from `<workspacePath>/agentbox.yaml`. Returns
 * `{}` if the file is missing or has no `defaults:` key. Throws on YAML
 * parse errors or invalid `defaults:` content (so typos surface as soon as
 * the user runs anything in the workspace).
 *
 * The rest of `agentbox.yaml` is owned by `@agentbox/ctl` — we don't validate
 * it here and we don't depend on that package.
 */
export async function loadProjectAgentboxDefaults(
  workspacePath: string,
  warnings: string[] = [],
): Promise<Partial<UserConfig>> {
  const path = workspaceConfigFile(workspacePath);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    // The ctl parser will surface its own error on the next box action; we
    // only throw if defaults: is present and broken (validated below).
    return {};
  }
  if (doc === null || doc === undefined || typeof doc !== 'object' || Array.isArray(doc)) {
    return {};
  }
  const defaults = (doc as Record<string, unknown>)['defaults'];
  if (defaults === undefined || defaults === null) return {};
  return parseUserConfigObject(defaults, `${path} defaults`, {
    onWarning: (m) => collectWarning(warnings, m),
  });
}

export interface LoadEffectiveConfigOptions {
  /** Highest-precedence layer; values supplied by command-line flags. */
  cliOverrides?: Partial<UserConfig>;
}

/**
 * Load and merge all four config sources for the cwd. Per-leaf precedence
 * (highest wins): cli > workspace > project > global > built-in defaults.
 *
 * The returned `sources` map has one entry per leaf in the registry — useful
 * for `agentbox config get --all` to show provenance.
 */
export async function loadEffectiveConfig(
  cwd: string,
  opts: LoadEffectiveConfigOptions = {},
): Promise<LoadedConfig> {
  const projectRoot = await findProjectRoot(cwd);
  const projectPath = projectConfigFile(projectRoot.root);
  const workspacePath = projectRoot.hasAgentboxYaml ? workspaceConfigFile(projectRoot.root) : null;

  const warnings: string[] = [];
  const [globalValues, projectValues, workspaceValues] = await Promise.all([
    loadOptionalUserConfig(GLOBAL_CONFIG_FILE, warnings),
    loadOptionalUserConfig(projectPath, warnings),
    workspacePath ? loadProjectAgentboxDefaults(projectRoot.root, warnings) : Promise.resolve({}),
  ]);

  const cliValues = opts.cliOverrides ?? {};

  const { effective, sources } = mergeLayers({
    cli: cliValues,
    workspace: workspaceValues,
    project: projectValues,
    global: globalValues,
  });

  return {
    effective,
    layers: {
      cli: { values: cliValues },
      workspace: { path: workspacePath, values: workspaceValues },
      project: { path: projectPath, values: projectValues },
      global: { path: GLOBAL_CONFIG_FILE, values: globalValues },
      defaults: BUILT_IN_DEFAULTS,
    },
    sources,
    projectRoot: projectRoot.root,
    projectHash: hashProjectPath(projectRoot.root),
    hasAgentboxYaml: projectRoot.hasAgentboxYaml,
    warnings,
  };
}

interface MergeInput {
  cli: Partial<UserConfig>;
  workspace: Partial<UserConfig>;
  project: Partial<UserConfig>;
  global: Partial<UserConfig>;
}

/**
 * Walk every key in KEY_REGISTRY, pick the highest-precedence layer that has
 * a leaf value, and record the source. Lower-precedence layers never
 * overwrite a higher-precedence definition; absent leaves don't shadow.
 */
function mergeLayers(input: MergeInput): {
  effective: EffectiveConfig;
  sources: Record<string, ConfigSource>;
} {
  // Deep-clone the defaults; we'll overwrite leaves in place.
  const effective: EffectiveConfig = JSON.parse(JSON.stringify(BUILT_IN_DEFAULTS)) as EffectiveConfig;
  const sources: Record<string, ConfigSource> = {};

  const layerOrder: Array<{ source: ConfigSource; values: Partial<UserConfig> }> = [
    { source: 'cli', values: input.cli },
    { source: 'workspace', values: input.workspace },
    { source: 'project', values: input.project },
    { source: 'global', values: input.global },
  ];

  for (const desc of KEY_REGISTRY) {
    const idx = desc.key.indexOf('.');
    const branch = desc.key.slice(0, idx);
    const leaf = desc.key.slice(idx + 1);

    let chosen: { source: ConfigSource; value: unknown } | null = null;
    for (const layer of layerOrder) {
      const v = readLeaf(layer.values, branch, leaf);
      if (v !== undefined) {
        chosen = { source: layer.source, value: v };
        break;
      }
    }

    if (chosen) {
      writeLeaf(effective, branch, leaf, chosen.value);
      sources[desc.key] = chosen.source;
    } else {
      sources[desc.key] = 'default';
    }
  }

  return { effective, sources };
}

function readLeaf(
  obj: Partial<UserConfig>,
  branch: string,
  leaf: string,
): unknown {
  let cur: unknown = (obj as Record<string, unknown>)[branch];
  for (const seg of leaf.split('.')) {
    if (cur === undefined || cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function writeLeaf(
  obj: EffectiveConfig,
  branch: string,
  leaf: string,
  value: unknown,
): void {
  let cur: Record<string, unknown> | undefined =
    (obj as unknown as Record<string, Record<string, unknown>>)[branch];
  if (!cur) return; // BUILT_IN_DEFAULTS guarantees the branch exists
  const segs = leaf.split('.');
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const next = cur[seg];
    if (next === undefined || next === null || typeof next !== 'object') {
      // BUILT_IN_DEFAULTS guarantees nested sub-objects exist for every
      // registered key path, so this is unreachable in practice; defaulting
      // to a fresh sub-object keeps the function total.
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]!] = value;
}
