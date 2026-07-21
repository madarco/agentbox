import { homedir } from 'node:os';
import { parse, stringify } from 'smol-toml';

/**
 * Sanitize the host's `~/.codex/config.toml` before it is seeded into a box.
 *
 * The host config routinely points at host-only absolute paths — the desktop
 * Codex.app's bundled MCP servers (`/Applications/Codex.app/...`), a macOS
 * `notify` helper, and local-source plugin marketplaces under the host home.
 * None of those exist in the Linux box, so in-box codex emits startup warnings
 * (`MCP client for \`node_repl\` failed to start: No such file or directory`,
 * etc.). We strip exactly the entries whose paths cannot resolve in the box and
 * leave everything else (model, reasoning effort, project trust, features, and
 * any MCP server reachable via PATH or a Linux-plausible absolute path).
 */

/**
 * True when `cmd` is an absolute path under a location guaranteed absent in the
 * Linux box: the host home, or a macOS-only / host-package root. Bare program
 * names (PATH-resolved, e.g. `node`, `npx`, `uvx`) and Linux-plausible
 * absolutes (`/usr/...`, `/bin/...`) are kept — we never over-strip.
 */
export function isHostOnlyPath(cmd: unknown, hostHome: string): boolean {
  if (typeof cmd !== 'string' || cmd.length === 0) return false;
  if (!cmd.startsWith('/')) return false; // PATH-resolved bare name — may exist in box
  const hostOnlyRoots = [
    hostHome.endsWith('/') ? hostHome : `${hostHome}/`,
    '/Applications/',
    '/opt/homebrew/',
    '/Library/',
    '/System/',
    '/private/',
    '/Users/',
  ];
  return hostOnlyRoots.some((root) => cmd.startsWith(root));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The box workspace path — Codex must trust it so it doesn't pop the "trust
 *  this folder?" prompt on first attach. Same value the docker + cloud paths
 *  mount the project at. */
export const BOX_WORKSPACE = '/workspace';

/** Minimal config.toml that pre-trusts `/workspace`, for a host with no
 *  `~/.codex/config.toml` to sanitize (so the box still skips the trust prompt). */
export const MINIMAL_TRUSTED_CODEX_CONFIG = `[projects."${BOX_WORKSPACE}"]\ntrust_level = "trusted"\n`;

export interface SanitizeCodexConfigResult {
  /** Sanitized TOML (re-serialized); equals the input semantically when `changed` is false. */
  text: string;
  /** True when at least one host-only entry was stripped. */
  changed: boolean;
  /**
   * Marketplace names still present after the local-source drop. The cloud
   * staging path uses this as the keep-set when purging orphaned
   * `plugins/cache/<marketplace>` dirs (the docker path uses the merged
   * config's set instead — see {@link mergeCodexConfigForBox}).
   */
  keptMarketplaces: string[];
}

/**
 * Parse → mutate → re-serialize the codex `config.toml`, dropping entries that
 * reference host-only paths. Throws on a TOML parse failure so callers can fall
 * back to copying the file verbatim. Reformatting (lost comments / reordered
 * keys) is acceptable: the box copy is derived and consumed only by in-box codex.
 *
 * Returns `changed: false` (so callers can keep the host's original copy
 * untouched) when nothing host-only was found.
 */
export function sanitizeCodexConfigForBox(
  tomlText: string,
  hostHome: string = homedir(),
): SanitizeCodexConfigResult {
  const cfg = parse(tomlText) as Record<string, unknown>;
  let changed = false;

  // mcp_servers: drop servers whose `command` is a host-only path.
  if (isRecord(cfg['mcp_servers'])) {
    const servers = cfg['mcp_servers'];
    for (const [name, def] of Object.entries(servers)) {
      if (isRecord(def) && isHostOnlyPath(def['command'], hostHome)) {
        delete servers[name];
        changed = true;
      }
    }
  }

  // notify: an array whose first element is the program to run. Drop the key
  // when that program is a host-only path.
  const notify = cfg['notify'];
  if (Array.isArray(notify) && isHostOnlyPath(notify[0], hostHome)) {
    delete cfg['notify'];
    changed = true;
  }

  // marketplaces: drop local-source marketplaces under a host-only path, then
  // drop the plugins that reference them (`"<plugin>@<marketplace>"`).
  const droppedMarkets = new Set<string>();
  if (isRecord(cfg['marketplaces'])) {
    const markets = cfg['marketplaces'];
    for (const [name, def] of Object.entries(markets)) {
      if (
        isRecord(def) &&
        def['source_type'] === 'local' &&
        isHostOnlyPath(def['source'], hostHome)
      ) {
        delete markets[name];
        droppedMarkets.add(name);
        changed = true;
      }
    }
  }
  if (droppedMarkets.size > 0 && isRecord(cfg['plugins'])) {
    const plugins = cfg['plugins'];
    for (const key of Object.keys(plugins)) {
      const marketplace = key.split('@')[1];
      if (marketplace !== undefined && droppedMarkets.has(marketplace)) {
        delete plugins[key];
        changed = true;
      }
    }
  }

  // Pre-trust the box workspace so codex doesn't prompt "trust this folder?" on
  // first attach. The box mounts the project at /workspace; the host config only
  // trusts host-absolute project paths, never /workspace. (Codex's own
  // path-based `[projects."<path>"].trust_level` is stable — unlike the
  // hash-based hook trust — so this is safe to persist.)
  if (!isRecord(cfg['projects'])) cfg['projects'] = {};
  const projects = cfg['projects'] as Record<string, unknown>;
  const wsEntry = isRecord(projects[BOX_WORKSPACE]) ? projects[BOX_WORKSPACE] : {};
  if (wsEntry['trust_level'] !== 'trusted') {
    wsEntry['trust_level'] = 'trusted';
    projects[BOX_WORKSPACE] = wsEntry;
    changed = true;
  }

  const keptMarketplaces = isRecord(cfg['marketplaces']) ? Object.keys(cfg['marketplaces']) : [];
  return { text: changed ? stringify(cfg) : tomlText, changed, keptMarketplaces };
}

export interface MergeCodexConfigResult {
  /** Final box TOML: the host-sanitized base with box-only entries folded in. */
  text: string;
  /**
   * Marketplace names in the merged config — the keep-set for the orphaned
   * `plugins/cache` / `.tmp/marketplaces` purge. Taken from the merge (not the
   * sanitize) so marketplaces installed in-box keep their caches across syncs.
   */
  marketplaces: string[];
  /** True when at least one box-only entry was preserved. */
  mergedFromBox: boolean;
}

/** Tables whose second-level entries an in-box codex adds/manages itself. */
const BOX_MERGED_TABLES = ['marketplaces', 'plugins', 'mcp_servers', 'projects'] as const;

/**
 * Merge the box's existing `config.toml` into the sanitized host copy, so
 * re-seeding the box config stops wiping in-box state (`codex plugin add`,
 * `codex mcp add`, marketplaces codex bootstrapped itself, `/model` picks).
 *
 * Host-authoritative: the host-sanitized text is the base and wins on every
 * overlapping key — so an in-box enable/disable flip of a plugin the host also
 * lists reverts on the next sync, by design. Only *box-only* state survives:
 * second-level entries of {@link BOX_MERGED_TABLES} and box-only top-level
 * keys. The additive fold also means an entry deleted on the host lives on in
 * the box until removed there (or the volume is isolated/recreated).
 *
 * `hostSanitizedText` must be parseable (it is sanitizer output or
 * {@link MINIMAL_TRUSTED_CODEX_CONFIG}); a parse throw propagates to the
 * caller's best-effort catch. A null or unparseable `boxText` degrades to the
 * host text verbatim — never fail the sync over a corrupt box config.
 */
export function mergeCodexConfigForBox(
  hostSanitizedText: string,
  boxText: string | null,
): MergeCodexConfigResult {
  const host = parse(hostSanitizedText) as Record<string, unknown>;
  const hostMarketplaces = (): string[] =>
    isRecord(host['marketplaces']) ? Object.keys(host['marketplaces']) : [];

  if (boxText === null) {
    return { text: hostSanitizedText, marketplaces: hostMarketplaces(), mergedFromBox: false };
  }
  let box: Record<string, unknown>;
  try {
    box = parse(boxText) as Record<string, unknown>;
  } catch {
    return { text: hostSanitizedText, marketplaces: hostMarketplaces(), mergedFromBox: false };
  }

  let merged = false;
  for (const table of BOX_MERGED_TABLES) {
    const boxTable = box[table];
    if (!isRecord(boxTable)) continue;
    const hostTable = isRecord(host[table]) ? host[table] : {};
    for (const [name, def] of Object.entries(boxTable)) {
      if (name in hostTable) continue; // host wins on overlap
      hostTable[name] = def;
      merged = true;
    }
    if (Object.keys(hostTable).length > 0) host[table] = hostTable;
  }
  for (const [key, value] of Object.entries(box)) {
    if ((BOX_MERGED_TABLES as readonly string[]).includes(key)) continue;
    if (key in host) continue; // host wins on overlap
    host[key] = value;
    merged = true;
  }

  const marketplaces = isRecord(host['marketplaces']) ? Object.keys(host['marketplaces']) : [];
  return {
    text: merged ? stringify(host) : hostSanitizedText,
    marketplaces,
    mergedFromBox: merged,
  };
}
