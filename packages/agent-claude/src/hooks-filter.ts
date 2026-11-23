import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HookFilterResult<T = unknown> {
  data: T;
  removedCommands: string[];
}

/**
 * Predicate for the filter: does `command` look like it points at a host path
 * outside the project, i.e. under the user's host home directory?
 *
 * Uses `.includes(hostHome + '/')` so we also catch shell-quoted forms like
 * `bash -c '/Users/marco/.config/iterm2/cc-status'`. The trailing slash gates
 * against false matches on similar-prefix home dirs (e.g. `/Users/marco`
 * shouldn't match `/Users/marco-other/...`).
 *
 * Returns false when `hostHome` is empty so we degrade safely if no home is
 * resolvable for some reason.
 */
export function isHostPathHookCommand(command: string, hostHome: string): boolean {
  if (typeof command !== 'string' || command.length === 0) return false;
  if (hostHome.length === 0) return false;
  return command.includes(hostHome + '/');
}

interface HookLeaf {
  type?: string;
  command?: string;
  [k: string]: unknown;
}

interface HookMatcherEntry {
  hooks?: unknown;
  [k: string]: unknown;
}

/**
 * Walk Claude Code's documented `hooks.<Trigger>[].hooks[]` structure and drop
 * any leaf `{ type: 'command', command: '<host-path>' }` whose `command` matches
 * {@link isHostPathHookCommand}. Empty `hooks: []` arrays and their matcher
 * wrappers are left intact — they don't break Claude and avoiding recursive
 * cleanup keeps the filter predictable.
 *
 * Returns a deep clone; input is not mutated. Tolerant of unexpected shapes
 * (string, number, null at any level): unrecognized branches pass through
 * unchanged, removed count stays accurate.
 */
export function filterHostHooks<T = unknown>(data: T, hostHome: string): HookFilterResult<T> {
  // structuredClone is in node >= 17; the repo targets node20, so this is safe.
  const clone = structuredClone(data) as unknown;
  const removedCommands: string[] = [];

  if (clone === null || typeof clone !== 'object' || Array.isArray(clone)) {
    return { data: clone as T, removedCommands };
  }

  const top = clone as { hooks?: unknown };
  const hooksRoot = top.hooks;
  if (hooksRoot === null || typeof hooksRoot !== 'object' || Array.isArray(hooksRoot)) {
    return { data: clone as T, removedCommands };
  }

  for (const triggerName of Object.keys(hooksRoot as Record<string, unknown>)) {
    const triggerValue = (hooksRoot as Record<string, unknown>)[triggerName];
    if (!Array.isArray(triggerValue)) continue;
    for (const entry of triggerValue) {
      if (entry === null || typeof entry !== 'object') continue;
      const matcher = entry as HookMatcherEntry;
      const inner = matcher.hooks;
      if (!Array.isArray(inner)) continue;
      // In-place filter on the cloned array.
      for (let i = inner.length - 1; i >= 0; i--) {
        const leaf = inner[i] as HookLeaf | null;
        if (leaf === null || typeof leaf !== 'object') continue;
        if (
          leaf.type === 'command' &&
          typeof leaf.command === 'string' &&
          isHostPathHookCommand(leaf.command, hostHome)
        ) {
          removedCommands.push(leaf.command);
          inner.splice(i, 1);
        }
      }
    }
  }

  return { data: clone as T, removedCommands };
}

export interface SetInstallMethodNativeResult<T = unknown> {
  data: T;
  applied: boolean;
}

export interface AddProjectAliasResult<T = unknown> {
  data: T;
  aliased: boolean;
}

export interface TrustWorkspaceResult<T = unknown> {
  data: T;
  trusted: boolean;
}

/**
 * Force `projects[workspacePath].hasTrustDialogAccepted = true` in a parsed
 * `~/.claude.json`, creating the `projects` map and the project entry if
 * absent.
 *
 * The box is a sandbox: the agent is created explicitly to work in
 * `/workspace`, and the box is isolated from the host — so the folder-trust
 * dialog is pointless there. More importantly, Claude Code, when it opens an
 * *untrusted* folder, sends a malformed first API request that Anthropic
 * rejects with `400 role 'system' is not supported on this model`. Pre-trusting
 * the box's workspace skips the dialog *and* dodges that bug.
 *
 * Returns a deep-cloned, modified copy plus a flag for whether anything
 * changed (`false` when it was already trusted). Input is not mutated; no-op
 * for non-object data or an empty path.
 */
export function trustWorkspace<T = unknown>(
  data: T,
  workspacePath: string,
): TrustWorkspaceResult<T> {
  const clone = structuredClone(data) as unknown;
  if (clone === null || typeof clone !== 'object' || Array.isArray(clone)) {
    return { data: clone as T, trusted: false };
  }
  if (workspacePath.length === 0) return { data: clone as T, trusted: false };
  const obj = clone as { projects?: unknown };
  if (obj.projects === null || typeof obj.projects !== 'object' || Array.isArray(obj.projects)) {
    obj.projects = {};
  }
  const projects = obj.projects as Record<string, unknown>;
  const existing = projects[workspacePath];
  const entry =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  if (entry.hasTrustDialogAccepted === true) {
    projects[workspacePath] = entry;
    return { data: clone as T, trusted: false };
  }
  entry.hasTrustDialogAccepted = true;
  projects[workspacePath] = entry;
  return { data: clone as T, trusted: true };
}

/**
 * Claude Code keys project-scoped state (history, mcpServers, enabledPlugins,
 * trust prompts) under `projects[<absolute-workspace-path>]` in
 * `~/.claude.json`. On the host the key is something like
 * `/Users/marco/Projects/foo`; inside the box the workspace is always
 * `/workspace`. Without rewriting, the box never sees the host's project-
 * scoped settings.
 *
 * Copy (don't move) the host-keyed entry to `toPath` if present. Existing
 * `projects[toPath]` is preserved by merging the host entry on top — host
 * is authoritative for keys it sets; box-only keys (e.g. session ids
 * accumulated inside earlier boxes) stay intact.
 *
 * No-op (returns `aliased: false`) when:
 *   - data isn't an object, or `projects` isn't an object
 *   - fromPath equals toPath
 *   - projects[fromPath] doesn't exist or isn't an object
 *
 * Returns a deep-cloned, modified copy; input is not mutated.
 */
export function addProjectAlias<T = unknown>(
  data: T,
  fromPath: string,
  toPath: string,
): AddProjectAliasResult<T> {
  const clone = structuredClone(data) as unknown;
  if (clone === null || typeof clone !== 'object' || Array.isArray(clone)) {
    return { data: clone as T, aliased: false };
  }
  if (fromPath === toPath || fromPath.length === 0 || toPath.length === 0) {
    return { data: clone as T, aliased: false };
  }
  const obj = clone as { projects?: unknown };
  const projects = obj.projects;
  if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) {
    return { data: clone as T, aliased: false };
  }
  const projectsMap = projects as Record<string, unknown>;
  const src = projectsMap[fromPath];
  if (src === null || typeof src !== 'object' || Array.isArray(src)) {
    return { data: clone as T, aliased: false };
  }
  const existing = projectsMap[toPath];
  if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
    projectsMap[toPath] = {
      ...(existing as Record<string, unknown>),
      ...(src as Record<string, unknown>),
    };
  } else {
    projectsMap[toPath] = structuredClone(src);
  }
  return { data: clone as T, aliased: true };
}

/**
 * Force the install-method fields in a parsed `~/.claude.json` to match the
 * box's native install. Sets exactly what `claude install` writes:
 *   installMethod: "native"
 *   autoUpdates: false
 *   autoUpdatesProtectedForNative: true
 *
 * Without this, the in-box claude reports
 * `Running native installation but config install method is 'not set'` in
 * /status — the host's value (often `npm-global` on Mac, or absent) doesn't
 * match the box's `~/.local/bin/claude` install location, and merely
 * clearing the field leaves it unset rather than fixing it.
 *
 * Returns a deep-cloned, fixed copy plus a flag indicating whether any of
 * the three fields actually changed. Input is not mutated.
 */
export function setInstallMethodNative<T = unknown>(data: T): SetInstallMethodNativeResult<T> {
  const clone = structuredClone(data) as unknown;
  if (clone === null || typeof clone !== 'object' || Array.isArray(clone)) {
    return { data: clone as T, applied: false };
  }
  const obj = clone as Record<string, unknown>;
  const changed =
    obj.installMethod !== 'native' ||
    obj.autoUpdates !== false ||
    obj.autoUpdatesProtectedForNative !== true;
  obj.installMethod = 'native';
  obj.autoUpdates = false;
  obj.autoUpdatesProtectedForNative = true;
  return { data: clone as T, applied: changed };
}

/**
 * Where Claude Code keeps model endpoints in `settings.json`: the `env` block's
 * `*_BASE_URL` keys (`ANTHROPIC_BASE_URL`, `ANTHROPIC_BEDROCK_BASE_URL`, …),
 * which Claude Code exports into its own process. Derived from the data so a
 * new `*_BASE_URL` variable needs no list here.
 */
export function claudeSettingsEndpointPaths(data: unknown): string[][] {
  if (typeof data !== 'object' || data === null) return [];
  const env = (data as Record<string, unknown>)['env'];
  if (typeof env !== 'object' || env === null || Array.isArray(env)) return [];
  return Object.keys(env)
    .filter((k) => k.endsWith('_BASE_URL'))
    .map((k) => ['env', k]);
}

/**
 * Top-level `~/.claude.json` keys that describe WHICH account a config belongs
 * to rather than how the user configured Claude Code (Phase 0, (a) and (a′)):
 * the cached profile, the account-derived caches not keyed by account or org,
 * and the stored answer to "use this API key?". A named account's volume is
 * seeded from the host's file without them, so the first turn fetches the
 * account's own profile instead of showing the owner's.
 */
export const ACCOUNT_STATE_KEYS: readonly string[] = [
  'oauthAccount',
  // A Console API key Claude Code stored for the host login: the owner's secret.
  'primaryApiKey',
  'customApiKeyResponses',
  'modelAccessCache',
  'orgModelDefaultCache',
  'additionalModelOptionsCache',
  'additionalModelCostsCache',
  'cachedExtraUsageDisabledReason',
];

/** The jq program that drops {@link ACCOUNT_STATE_KEYS}. Keys are plain identifiers. */
export function accountStateJqDelete(): string {
  return `del(${ACCOUNT_STATE_KEYS.map((k) => `.${k}`).join(', ')})`;
}

/** Drop {@link ACCOUNT_STATE_KEYS}. Pure; `stripped` is false when none were present. */
export function stripAccountState<T = unknown>(data: T): { data: T; stripped: boolean } {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { data, stripped: false };
  }
  const rec = data as Record<string, unknown>;
  if (!ACCOUNT_STATE_KEYS.some((k) => k in rec)) return { data, stripped: false };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) if (!ACCOUNT_STATE_KEYS.includes(k)) out[k] = v;
  return { data: out as T, stripped: true };
}

/**
 * `settings.json` `env` keys that carry a credential. A named account's volume
 * must not inherit the owner's: Claude prefers an API key over its OAuth login
 * (Phase 0 (a′)), so the account would run and bill on the owner.
 */
export const AUTH_SETTINGS_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

/** Drop {@link AUTH_SETTINGS_ENV_KEYS} from `env` and `apiKeyHelper`. Pure. */
export function stripAuthSettings<T = unknown>(data: T): { data: T; stripped: boolean } {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { data, stripped: false };
  }
  const rec = { ...(data as Record<string, unknown>) };
  let stripped = false;
  if ('apiKeyHelper' in rec) {
    delete rec.apiKeyHelper;
    stripped = true;
  }
  const env = rec.env;
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    const next = { ...(env as Record<string, unknown>) };
    for (const k of AUTH_SETTINGS_ENV_KEYS) {
      if (k in next) {
        delete next[k];
        stripped = true;
      }
    }
    rec.env = next;
  }
  return stripped ? { data: rec as T, stripped: true } : { data, stripped: false };
}

/** A hub's MCP endpoint, in any MCP server's `url`. */
const HUB_MCP_URL = /\/api\/mcp(?:[/?#]|$)/;

/**
 * Drop MCP servers that would hand a box the hub's credential
 * (docs/agent-history-plan.md, Phase 6): any `mcpServers` entry, top-level or
 * under `projects[*]`, whose definition contains one of `secrets` (the hub
 * token, the hub API key) or whose `url` is a hub's `/api/mcp`. A box reaches
 * the hub's MCP tools through its own relay (`agentbox-ctl mcp`), scoped to
 * its repo; a copied host entry would be the unscoped admin credential.
 */
export function stripHubMcpServers<T = unknown>(
  data: T,
  secrets: readonly string[],
): { data: T; removed: string[] } {
  const removed: string[] = [];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { data, removed };
  const usable = secrets.filter((s) => s.length >= 8);
  const leaks = (def: unknown): boolean => {
    const text = JSON.stringify(def) ?? '';
    if (usable.some((s) => text.includes(s))) return true;
    const url = (def as { url?: unknown } | null)?.url;
    return typeof url === 'string' && HUB_MCP_URL.test(url);
  };
  const clean = (servers: unknown, where: string): unknown => {
    if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return servers;
    const out: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
      if (leaks(def)) removed.push(`${where}${name}`);
      else out[name] = def;
    }
    return out;
  };
  const root = { ...(data as Record<string, unknown>) };
  if ('mcpServers' in root) root.mcpServers = clean(root.mcpServers, '');
  const projects = root.projects;
  if (projects !== null && typeof projects === 'object' && !Array.isArray(projects)) {
    const next: Record<string, unknown> = {};
    for (const [key, proj] of Object.entries(projects as Record<string, unknown>)) {
      if (
        proj !== null &&
        typeof proj === 'object' &&
        !Array.isArray(proj) &&
        'mcpServers' in proj
      ) {
        const p = proj as Record<string, unknown>;
        next[key] = { ...p, mcpServers: clean(p.mcpServers, `${key}:`) };
      } else {
        next[key] = proj;
      }
    }
    root.projects = next;
  }
  return removed.length > 0 ? { data: root as T, removed } : { data, removed };
}

/** The hub credentials on this machine that must never ride a copied MCP config. */
export function hubSecretsOnHost(hostHome: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  try {
    const t = readFileSync(join(hostHome, '.agentbox', 'hub', 'token'), 'utf8').trim();
    if (t) out.push(t);
  } catch {
    /* no local hub */
  }
  for (const k of ['AGENTBOX_HUB_TOKEN', 'AGENTBOX_HUB_API_KEY', 'AGENTBOX_RELAY_ADMIN_TOKEN']) {
    const v = env[k]?.trim();
    if (v) out.push(v);
  }
  return out;
}
