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
    projectsMap[toPath] = { ...(existing as Record<string, unknown>), ...(src as Record<string, unknown>) };
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
