import { homedir } from 'node:os';
import { join } from 'node:path';
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

/** The box's `~/.codex` — host `<home>/.codex` paths in config.toml are
 *  rewritten to this so in-`~/.codex` marketplace sources resolve in the box. */
const BOX_CODEX_DIR = '/home/vscode/.codex';

/** Minimal config.toml that pre-trusts `/workspace`, for a host with no
 *  `~/.codex/config.toml` to sanitize (so the box still skips the trust prompt). */
export const MINIMAL_TRUSTED_CODEX_CONFIG = `[projects."${BOX_WORKSPACE}"]\ntrust_level = "trusted"\n`;

export interface SanitizeCodexConfigResult {
  /** Sanitized TOML (re-serialized); equals the input semantically when `changed` is false. */
  text: string;
  /** True when at least one host-only entry was stripped. */
  changed: boolean;
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
  // A local marketplace whose source lives **under the host `~/.codex`** ships
  // into the box inside the codex volume (e.g. codex's bundled `openai-bundled`
  // marketplace at `~/.codex/.tmp/bundled-marketplaces`, which backs the Browser
  // plugin). Keep those, rewriting the host path to the box path so codex finds
  // the content. Local marketplaces under any OTHER host-only path don't ship
  // (e.g. the `openai-primary-runtime` runtime under `~/.cache`, ~1.3GB, backing
  // Documents/Sheets/Slides; or a user's custom local marketplace) — drop them,
  // and the dependent plugins below.
  const hostCodex = join(hostHome, '.codex');
  const droppedMarkets = new Set<string>();
  if (isRecord(cfg['marketplaces'])) {
    const markets = cfg['marketplaces'];
    for (const [name, def] of Object.entries(markets)) {
      if (
        isRecord(def) &&
        def['source_type'] === 'local' &&
        isHostOnlyPath(def['source'], hostHome)
      ) {
        const src = def['source'];
        if (typeof src === 'string' && (src === hostCodex || src.startsWith(hostCodex + '/'))) {
          def['source'] = BOX_CODEX_DIR + src.slice(hostCodex.length);
          changed = true;
        } else {
          delete markets[name];
          droppedMarkets.add(name);
          changed = true;
        }
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

  return { text: changed ? stringify(cfg) : tomlText, changed };
}
