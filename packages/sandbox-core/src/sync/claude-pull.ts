/**
 * Pure helpers for `agentbox download claude` (box -> host pull of Claude
 * extensions): the delta + JSON-merge logic, unit-testable without spawning
 * containers. Consumed by `agent-pull.ts` (the shared pull core) and, through
 * it, by both the docker volume pull and the cloud transport pull.
 *
 * The forward sync (`ensureClaudeVolume` in sandbox-docker) is host-authoritative
 * and rewrites `$HOST_HOME/.claude/plugins/` -> `/home/vscode/.claude/plugins/`
 * in the plugin registry JSONs. This module is the reverse: additive (host
 * wins, only missing items are added) and rewrites the container path back to
 * the host path.
 */

/** Categories under ~/.claude we pull box-side additions for. */
export const PULL_CATEGORIES = ['skills', 'plugins', 'agents', 'commands'] as const;
export type PullCategory = (typeof PULL_CATEGORIES)[number];

/**
 * Skills whose directory name starts with one of these prefixes are agentbox's
 * own (currently just `agentbox-setup`, seeded box-only into the claude-config
 * volume by `seedSetupSkillIntoVolume` in claude.ts — never on the host).
 * Pulling them back would re-introduce them onto the host, which is exactly
 * what the box-only design avoids, so we never treat them as user-authored
 * additions.
 */
export const SKILL_EXCLUDE_PREFIXES = ['agentbox-'] as const;

/** Container path prefix the forward sync rewrites host plugin paths to. */
export const CONTAINER_PLUGINS_PREFIX = '/home/vscode/.claude/plugins/';

/**
 * Set-difference of `boxNames` against `hostNames`, dropping any name that
 * starts with one of `excludePrefixes`. Result is sorted for stable output.
 * Used for skills/agents/commands (top-level dir names) and plugin cache
 * (`<marketplace>/<plugin>` keys).
 */
export function pickNewItems(
  boxNames: string[],
  hostNames: string[],
  excludePrefixes: readonly string[] = [],
): string[] {
  const host = new Set(hostNames);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of boxNames) {
    if (name.length === 0 || host.has(name) || seen.has(name)) continue;
    if (excludePrefixes.some((p) => name.startsWith(p))) continue;
    seen.add(name);
    out.push(name);
  }
  return out.sort();
}

/**
 * Rewrite the forward sync's container plugin prefix back to the host's, in
 * every string anywhere in `value`. Generic over the JSON shape so it covers
 * both `installLocation` (known_marketplaces.json) and `installPath`
 * (installed_plugins.json) plus any future path-bearing field.
 */
function rewritePluginPaths<T>(value: T, hostPluginsPrefix: string): T {
  if (typeof value === 'string') {
    return value.split(CONTAINER_PLUGINS_PREFIX).join(hostPluginsPrefix) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewritePluginPaths(v, hostPluginsPrefix)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = rewritePluginPaths(v, hostPluginsPrefix);
    }
    return out as T;
  }
  return value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export interface MergeResult {
  /** Merged JSON to write back to the host (the host object plus added keys). */
  data: unknown;
  /** True when at least one key was added (caller should write on true only). */
  changed: boolean;
  /** Keys added to the host map, for the preview/summary. */
  addedKeys: string[];
}

/**
 * Additive object-key merge. For every key in `boxMap` absent from `hostMap`,
 * copy the box's value in (with plugin paths rewritten to the host prefix).
 * Existing host keys are never touched. Tolerant of missing / non-object
 * inputs: returns the host value unchanged with `changed: false` (matches
 * `maybeFilterTo`'s defensiveness in claude.ts).
 *
 * `selectMap` projects the registry object to the map being merged
 * (identity for known_marketplaces.json, `.plugins` for installed_plugins.json)
 * and `withMap` writes the merged map back into a clone of the host registry.
 */
function additiveMerge(
  hostRoot: unknown,
  boxRoot: unknown,
  hostPluginsPrefix: string,
  selectMap: (root: unknown) => unknown,
  withMap: (hostRoot: unknown, mergedMap: Record<string, unknown>) => unknown,
): MergeResult {
  const hostMap = selectMap(hostRoot);
  const boxMap = selectMap(boxRoot);
  if (!isPlainObject(boxMap)) {
    return { data: hostRoot, changed: false, addedKeys: [] };
  }
  const base: Record<string, unknown> = isPlainObject(hostMap) ? { ...hostMap } : {};
  const addedKeys: string[] = [];
  for (const [key, value] of Object.entries(boxMap)) {
    if (Object.prototype.hasOwnProperty.call(base, key)) continue;
    base[key] = rewritePluginPaths(value, hostPluginsPrefix);
    addedKeys.push(key);
  }
  if (addedKeys.length === 0) {
    return { data: hostRoot, changed: false, addedKeys: [] };
  }
  return { data: withMap(hostRoot, base), changed: true, addedKeys: addedKeys.sort() };
}

/**
 * known_marketplaces.json is a flat object keyed by marketplace name
 * (`{ "<name>": { source, installLocation, lastUpdated } }`). Add box-only
 * marketplaces; rewrite their `installLocation` back to the host path.
 */
export function mergeKnownMarketplaces(
  hostJson: unknown,
  boxJson: unknown,
  opts: { hostHome: string },
): MergeResult {
  const prefix = `${opts.hostHome}/.claude/plugins/`;
  return additiveMerge(
    isPlainObject(hostJson) ? hostJson : {},
    boxJson,
    prefix,
    (root) => root,
    (_host, merged) => merged,
  );
}

/**
 * installed_plugins.json is `{ version, plugins: { "<name>@<mkt>": [...] } }`.
 * Add box-only entries under `.plugins`; rewrite each entry's `installPath`
 * back to the host path. The top-level `version` and any other host keys are
 * preserved as-is.
 */
export function mergeInstalledPlugins(
  hostJson: unknown,
  boxJson: unknown,
  opts: { hostHome: string },
): MergeResult {
  const prefix = `${opts.hostHome}/.claude/plugins/`;
  const hostRoot = isPlainObject(hostJson) ? hostJson : { plugins: {} };
  return additiveMerge(
    hostRoot,
    boxJson,
    prefix,
    (root) => (isPlainObject(root) ? (root as Record<string, unknown>)['plugins'] : undefined),
    (host, merged) => ({ ...(host as Record<string, unknown>), plugins: merged }),
  );
}

/**
 * Collect the set of `<marketplace>/<plugin>/<version>` cache keys that
 * `installed_plugins.json` actively references — every entry's `installPath`
 * reduced to its last three path segments. The plugin cache is a fixed
 * three-level tree (`cache/<m>/<p>/<v>/`), so the last three segments uniquely
 * identify the version dir regardless of whether the path is host-rooted
 * (`/Users/...`) or container-rooted (`/home/vscode/...`).
 *
 * Used to tell stale plugin-version dirs (an old version Claude left behind
 * after an update) apart from live ones, so a rebuild pass can prune the stale
 * ones' `node_modules` and never reinstall them. Returns an empty set for
 * missing / non-object input or entries without a usable `installPath` — the
 * caller treats "empty" as "can't determine, do nothing".
 */
export function referencedPluginVersionKeys(installedPluginsJson: unknown): Set<string> {
  const keys = new Set<string>();
  if (!isPlainObject(installedPluginsJson)) return keys;
  const plugins = installedPluginsJson['plugins'];
  if (!isPlainObject(plugins)) return keys;
  for (const entries of Object.values(plugins)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isPlainObject(entry)) continue;
      const installPath = entry['installPath'];
      if (typeof installPath !== 'string') continue;
      const segments = installPath.split('/').filter((s) => s.length > 0);
      if (segments.length < 3) continue;
      keys.add(segments.slice(-3).join('/'));
    }
  }
  return keys;
}
