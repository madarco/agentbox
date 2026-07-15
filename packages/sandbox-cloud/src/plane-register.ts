/**
 * Register a control-plane cloud box on the hosted plane (not the laptop relay).
 *
 * A classic-cloud box is registered on the laptop's loopback relay (which then
 * runs a CloudBoxPoller to drain its /bridge). A control-plane box instead
 * forwards its /rpc straight to the plane, so it must be registered *on the
 * plane* — with its **origin URL**, which the plane needs to mint a repo-scoped
 * GitHub-App push token (`leaseTokenResult` mints from the registered origin,
 * never from box params). Uses the plane's admin bearer over HTTPS, mirroring
 * `apps/cli/src/control-plane/ensure-repo-installed.ts`.
 */
import { execa } from 'execa';

export interface RegisterBoxWithPlaneArgs {
  controlPlaneUrl: string;
  adminToken: string;
  boxId: string;
  token: string;
  name: string;
  originUrl: string;
  backend: string;
  /**
   * Provider-native sandbox id. Persisted on the plane registration so a PC can
   * adopt the box (`agentbox hub pull`) — the SSH key material is keyed by this
   * id on disk — and a reap can find its custody `boxes/<sandboxId>/` subtree.
   */
  sandboxId?: string;
  /**
   * Registered worktrees (containerPath/branch/sanctionedBranch). The plane's
   * lease gate auto-allows only the box's sanctioned `agentbox/*` branch, and
   * it reads that from the REGISTRATION (host-authoritative), never from box
   * params — without this a control-plane box's `git push` blocks on a human
   * approval that auto-approve should have covered.
   */
  worktrees?: Array<{
    containerPath: string;
    hostMainRepo: string;
    branch: string;
    sanctionedBranch?: string;
  }>;
  bridgeToken?: string;
  previewUrl?: string;
  previewToken?: string;
  createdAt?: string;
  projectIndex?: number;
  autoApproveHostActions?: boolean;
  autoApproveSafeHostActions?: boolean;
}

/** Read the host workspace's `origin` remote URL (the box's push target). */
export async function readGitOriginUrl(workspacePath: string): Promise<string | undefined> {
  const r = await execa('git', ['-C', workspacePath, 'remote', 'get-url', 'origin'], {
    reject: false,
  });
  const url = (r.stdout ?? '').trim();
  return r.exitCode === 0 && url.length > 0 ? url : undefined;
}

/** POST /admin/register-box on the plane with the admin bearer. Throws on non-2xx. */
export async function registerBoxWithPlane(args: RegisterBoxWithPlaneArgs): Promise<void> {
  const url = `${args.controlPlaneUrl.replace(/\/$/, '')}/admin/register-box`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.adminToken}`,
    },
    body: JSON.stringify({
      boxId: args.boxId,
      token: args.token,
      name: args.name,
      kind: 'cloud',
      backend: args.backend,
      sandboxId: args.sandboxId,
      originUrl: args.originUrl,
      worktrees: args.worktrees,
      bridgeToken: args.bridgeToken,
      previewUrl: args.previewUrl,
      previewToken: args.previewToken,
      createdAt: args.createdAt,
      projectIndex: args.projectIndex,
      autoApproveHostActions: args.autoApproveHostActions,
      autoApproveSafeHostActions: args.autoApproveSafeHostActions,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`plane register-box → ${String(res.status)}: ${text}`);
  }
}
