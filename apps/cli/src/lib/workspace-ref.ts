/**
 * Which workspace a `agentbox workspace|tasks|manager` invocation is about.
 *
 * Resolution order, most explicit first:
 *   1. `--workspace <id|path>`
 *   2. `$AGENTBOX_WORKSPACE` — set inside the manager's own session, so the
 *      manager agent's `agentbox tasks …` calls need no flag
 *   3. the registered workspace containing the cwd (longest root wins)
 *   4. inside a claude/codex session: the workspace registering that session
 *      creates at its folder
 *
 * The listing comes from the hub, but the cwd is matched against THIS machine's
 * folder mapping (`hosts[hostname()]`), so a remote hub's workspaces resolve
 * here exactly as a local one's: the record names the folder on every machine
 * that has one.
 */
import { hostname } from 'node:os';
import { findWorkspaceContaining } from '@agentbox/relay';
import { detectHostSession, registerHostManager, type HostSessionHint } from './host-session.js';
import type { WithHubOptions } from '../control-plane/with-hub.js';
import type { HubApiClient, HubApiWorkspace } from '../control-plane/hub-api-client.js';

export class WorkspaceRefError extends Error {}

/**
 * Which hub every workspace / task / manager-registration call goes to: the
 * CONFIGURED one. The store lives on the hub that owns the boxes, so with a
 * control box configured it is there and this machine has no copy to read.
 * Deliberately never `preferLocal` — `resolveHubTarget` already falls back to
 * the local hub when no control box is configured, which is the whole local
 * case. One helper so the choice is made once rather than per call site.
 */
export function workspaceHub(): WithHubOptions {
  return {};
}

/** Pure: apply the resolution order to an already-fetched listing. */
export function pickWorkspace(
  workspaces: HubApiWorkspace[],
  opts: { ref?: string; env?: string; cwd: string; host?: string },
): HubApiWorkspace | null {
  const host = opts.host ?? hostname();
  const explicit = opts.ref ?? opts.env;
  if (explicit) {
    const byId = workspaces.find((w) => w.id === explicit);
    if (byId) return byId;
    const normalized =
      explicit.length > 1 && explicit.endsWith('/') ? explicit.slice(0, -1) : explicit;
    const byRoot = workspaces.find((w) => w.hosts[host]?.root === normalized);
    if (byRoot) return byRoot;
    const byName = workspaces.filter((w) => w.name === explicit);
    // A name is a label, not a key: two workspaces can share one, and picking
    // either would silently act on the wrong folder.
    if (byName.length === 1) return byName[0]!;
    return null;
  }
  return findWorkspaceContaining(workspaces, opts.cwd, host);
}

/** Resolve, or throw a message that says how to fix it. */
export async function resolveWorkspace(
  client: HubApiClient,
  ref?: string,
): Promise<HubApiWorkspace> {
  return (await resolveWorkspaceAndManager(client, ref)).workspace;
}

/** Process seams, so a test drives resolution without the real env, cwd or ~/.claude. */
export interface WorkspaceRefDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  host?: string;
  detect?: () => HostSessionHint | undefined;
}

/**
 * Resolve the workspace and, inside a host agent session, the manager that
 * session is registered as.
 *
 * With nothing registered for the cwd, a session is enough: registering it
 * creates the workspace at the session's folder, so nobody has to declare one
 * first. `register` also registers when a workspace was found, for a caller that
 * needs the manager id (a task added from inside a session belongs to it).
 */
export async function resolveWorkspaceAndManager(
  client: Pick<HubApiClient, 'listWorkspaces' | 'detectManager'>,
  ref?: string,
  opts: { register?: boolean } = {},
  deps: WorkspaceRefDeps = {},
): Promise<{ workspace: HubApiWorkspace; managerId?: string }> {
  const workspaces = await client.listWorkspaces();
  const env = (deps.env ?? process.env)['AGENTBOX_WORKSPACE'];
  const cwd = deps.cwd ?? process.cwd();
  const explicit = ref ?? env;
  const host = deps.host ?? hostname();
  const picked = pickWorkspace(workspaces, {
    ...(ref ? { ref } : {}),
    ...(env ? { env } : {}),
    cwd,
    host,
  });
  if (!picked && explicit) {
    throw new WorkspaceRefError(
      `no workspace matches "${explicit}". List them with \`agentbox workspace list\`.`,
    );
  }
  let hint = !picked || opts.register ? (deps.detect ?? detectHostSession)() : undefined;
  // A workspace the user named is the one they want: registering a session that
  // lives elsewhere would create a second workspace at its folder, and hand the
  // task a manager from it.
  if (
    hint &&
    picked &&
    explicit &&
    findWorkspaceContaining(workspaces, hint.cwd, host)?.id !== picked.id
  ) {
    hint = undefined;
  }
  if (hint) {
    // The listing this resolution already fetched: the register call needs it to
    // decide whether the hub must be sent a folder scan.
    const registered = await registerHostManager(client, hint, undefined, { workspaces });
    if (registered && !picked) {
      return { workspace: registered.workspace, managerId: registered.managerId };
    }
    // The hub keeps an already-registered session in its own workspace, which
    // need not be the one picked here.
    if (registered && registered.workspace.id === picked?.id) {
      return { workspace: picked, managerId: registered.managerId };
    }
  }
  if (picked) return { workspace: picked };
  if (workspaces.length === 0) {
    throw new WorkspaceRefError(
      'no workspaces registered on this hub. Register one with `agentbox workspace add <path>`.',
    );
  }
  throw new WorkspaceRefError(
    `no registered workspace contains ${cwd}. Pass --workspace <id|path>, or register this folder with \`agentbox workspace add\`.`,
  );
}
