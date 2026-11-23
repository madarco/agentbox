import { readFile, writeFile } from 'node:fs/promises';
import { findLoopbackEndpoints, type LoopbackEndpoint } from '@agentbox/core';
import {
  addProjectAlias,
  claudeSettingsEndpointPaths,
  filterHostHooks,
  setInstallMethodNative,
  stripAccountState,
  stripAuthSettings,
  stripHubMcpServers,
  trustWorkspace,
} from './hooks-filter.js';

/**
 * Filter a host claude config file (`settings.json`, `.claude.json`) for a
 * box's config volume; writes `dest` only when something changed. Its own
 * module, free of docker and sandbox imports, so it is cheap to load.
 */
export async function maybeFilterTo(
  src: string,
  dest: string,
  hostHome: string,
  opts: {
    setInstallMethodNative?: boolean;
    aliasProject?: { from: string; to: string };
    trustWorkspacePath?: string;
    /** Rewrite host-loopback `env.*_BASE_URL` values to `host` (#403). */
    loopback?: { host: string; source: string };
    /** Drop the host's account state (a named LLM account's volume). */
    stripAccountState?: boolean;
    /** Drop auth-bearing `env.*` keys and `apiKeyHelper` from a settings file. */
    stripAuthSettings?: boolean;
    /** Drop MCP servers carrying these hub credentials or a hub `/api/mcp` url. */
    stripHubMcp?: readonly string[];
  } = {},
): Promise<{
  removedHooks: number;
  installMethodFixed: boolean;
  aliasedProjectKey: boolean;
  workspaceTrusted: boolean;
  accountStateStripped: boolean;
  loopbackEndpoints: LoopbackEndpoint[];
}> {
  const zero = {
    removedHooks: 0,
    installMethodFixed: false,
    aliasedProjectKey: false,
    workspaceTrusted: false,
    accountStateStripped: false,
    loopbackEndpoints: [],
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(src, 'utf8'));
  } catch {
    return zero;
  }
  const filtered = filterHostHooks(parsed, hostHome);
  let working: unknown = filtered.data;
  let installFixed = false;
  if (opts.setInstallMethodNative) {
    const r = setInstallMethodNative(working);
    working = r.data;
    installFixed = r.applied;
  }
  let aliased = false;
  if (opts.aliasProject) {
    const r = addProjectAlias(working, opts.aliasProject.from, opts.aliasProject.to);
    working = r.data;
    aliased = r.aliased;
  }
  let trusted = false;
  if (opts.trustWorkspacePath) {
    const r = trustWorkspace(working, opts.trustWorkspacePath);
    working = r.data;
    trusted = r.trusted;
  }
  let authSettingsStripped = false;
  if (opts.stripAuthSettings) {
    const r = stripAuthSettings(working);
    working = r.data;
    authSettingsStripped = r.stripped;
  }
  let accountStateStripped = false;
  if (opts.stripAccountState) {
    const r = stripAccountState(working);
    working = r.data;
    accountStateStripped = r.stripped;
  }
  let hubMcpStripped = false;
  if (opts.stripHubMcp) {
    const r = stripHubMcpServers(working, opts.stripHubMcp);
    working = r.data;
    hubMcpStripped = r.removed.length > 0;
  }
  const loopbackEndpoints = opts.loopback
    ? findLoopbackEndpoints(working, {
        paths: claudeSettingsEndpointPaths(working),
        source: opts.loopback.source,
        rewriteHost: opts.loopback.host,
      })
    : [];
  if (
    filtered.removedCommands.length === 0 &&
    !installFixed &&
    !aliased &&
    !trusted &&
    !accountStateStripped &&
    !authSettingsStripped &&
    !hubMcpStripped &&
    loopbackEndpoints.length === 0
  ) {
    return zero;
  }
  await writeFile(dest, JSON.stringify(working, null, 2));
  return {
    removedHooks: filtered.removedCommands.length,
    installMethodFixed: installFixed,
    aliasedProjectKey: aliased,
    workspaceTrusted: trusted,
    accountStateStripped: accountStateStripped || authSettingsStripped,
    loopbackEndpoints,
  };
}
