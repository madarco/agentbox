import type { CloudBackend, CloudHandle } from '@agentbox/core';
import type { GitPushMode } from '@agentbox/config';
import { bashScript, quoteShellArgv } from './shell.js';

/**
 * Kick the single in-box self-configure step (`agentbox-ctl bootstrap`) inside a
 * cloud sandbox. This replaces the three separate host-driven launches (dockerd,
 * the ctl daemon, VNC): the host now provisions, then runs ONE exec that hands
 * control to the box's idempotent bootstrap, which clones (optional) and starts
 * whatever isn't already live. The same kick serves create AND resume.
 *
 * The exec is synchronous — the host awaits the bootstrap so create still
 * reports readiness (the bootstrap detaches the long-lived daemons internally).
 * A non-zero exit means the ctl daemon failed to come up (fatal); dockerd/VNC
 * failures are best-effort inside the bootstrap and don't fail the exec.
 *
 * Env (relay tokens, dockerd/VNC flags, optional clone) is exported inline
 * rather than relied upon from the sandbox's provision-time env, so a stop/start
 * that doesn't preserve env still brings the box back the same way.
 */
export interface KickCloudBootstrapArgs {
  backend: CloudBackend;
  handle: CloudHandle;
  boxId: string;
  boxName: string;
  relayUrl?: string;
  relayToken?: string;
  bridgeToken?: string;
  /** Exported as AGENTBOX_WEB_PROXY_PORT (Vercel uses 8080). */
  webProxyPort?: number;
  /**
   * The bare host (no scheme) this box is reachable at, exported as
   * AGENTBOX_BOX_HOST so the in-box placeholder engine (`agentbox-ctl render`,
   * the `{{AGENTBOX_BOX_HOST}}` env-init pattern) resolves the real host instead
   * of the derived `<box-name>.localhost`. `<name>.localhost` for portless
   * backends, the public preview host (e.g. `<sub>.vercel.run`) otherwise. When
   * unset the in-box engine falls back to deriving `<box-name>.localhost`.
   */
  boxHost?: string;
  /** false → AGENTBOX_LAUNCH_DOCKERD=0 (Vercel can't run nested containers). */
  launchDockerd: boolean;
  /** Present → start the VNC stack with this password; undefined → VNC disabled. */
  vncPassword?: string;
  /**
   * Optional in-box clone. When set, the bootstrap clones /workspace from
   * `authedUrl` (token-bearing) and scrubs origin to `originUrl`. Used by the
   * plane / cloud-IDE create path; the laptop path host-seeds and omits this.
   */
  clone?: { authedUrl: string; originUrl: string; branch?: string; depth?: number };
  /**
   * Hosted control-plane base URL when this box's live relay is the plane. When
   * set, the kick exports `AGENTBOX_CONTROL_PLANE_URL` (daemon → forwarder
   * upstream) and writes `AGENTBOX_GIT_LEASE=1` into box.env (login-shell
   * `git push` → lease-and-push direct). Re-passed on every kick (create AND
   * reEnsure/attach) from the persisted record so resume preserves the topology.
   */
  controlPlaneUrl?: string;
  /**
   * Git push routing for this box (`git.pushMode`): `relay` (host relay pushes
   * with host creds), `lease` (box leases a token and pushes direct), or `auto`
   * (default — lease iff a control plane is configured). Only `lease` (explicit
   * or auto-with-control-plane) writes `AGENTBOX_GIT_LEASE=1`. Omitted = `auto`.
   */
  gitPushMode?: GitPushMode;
  onLog?: (line: string) => void;
}

/**
 * Pure builder for the two env surfaces a bootstrap kick emits. Split out so the
 * control-plane threading (`AGENTBOX_CONTROL_PLANE_URL` / `AGENTBOX_GIT_LEASE`)
 * is unit-testable without a backend.
 *
 * - `env` — exported for the bootstrap process + its detached children (the ctl
 *   daemon reads these). Carries the relay/bridge tokens + the clone + upstream.
 * - `boxEnvFile` — the identity + placeholder subset persisted to
 *   /etc/agentbox/box.env so interactive login shells (`agentbox shell`, and the
 *   tmux shell where `git push` runs) resolve the same values. box.env is
 *   world-readable (0644), so it deliberately excludes the relay/bridge tokens
 *   (those travel via the daemon's 0600 /run/agentbox/relay.env) but DOES carry
 *   the non-secret `AGENTBOX_GIT_LEASE` flag, which the login-shell `git push`
 *   must see. Written on every kick (create AND reEnsure/attach).
 */
export function buildBootstrapEnv(args: KickCloudBootstrapArgs): {
  env: string[];
  boxEnvFile: string[];
} {
  const env: string[] = [
    `AGENTBOX_BOX_ID=${quoteShellArgv([args.boxId])}`,
    `AGENTBOX_BOX_NAME=${quoteShellArgv([args.boxName])}`,
    `AGENTBOX_BOX_KIND=cloud`,
    `AGENTBOX_LAUNCH_DOCKERD=${args.launchDockerd ? '1' : '0'}`,
  ];
  if (args.relayUrl) env.push(`AGENTBOX_RELAY_URL=${quoteShellArgv([args.relayUrl])}`);
  if (args.relayToken) env.push(`AGENTBOX_RELAY_TOKEN=${quoteShellArgv([args.relayToken])}`);
  if (args.bridgeToken) env.push(`AGENTBOX_BRIDGE_TOKEN=${quoteShellArgv([args.bridgeToken])}`);
  if (args.webProxyPort !== undefined)
    env.push(`AGENTBOX_WEB_PROXY_PORT=${quoteShellArgv([String(args.webProxyPort)])}`);
  if (args.boxHost) env.push(`AGENTBOX_BOX_HOST=${quoteShellArgv([args.boxHost])}`);
  if (args.vncPassword) {
    env.push(`AGENTBOX_VNC_ENABLED=1`);
    env.push(`AGENTBOX_VNC_PASSWORD=${quoteShellArgv([args.vncPassword])}`);
  } else {
    env.push(`AGENTBOX_VNC_ENABLED=0`);
  }
  if (args.clone) {
    env.push(`AGENTBOX_CLONE_URL=${quoteShellArgv([args.clone.authedUrl])}`);
    env.push(`AGENTBOX_ORIGIN_URL=${quoteShellArgv([args.clone.originUrl])}`);
    if (args.clone.branch)
      env.push(`AGENTBOX_CLONE_BRANCH=${quoteShellArgv([args.clone.branch])}`);
    if (args.clone.depth !== undefined)
      env.push(`AGENTBOX_CLONE_DEPTH=${quoteShellArgv([String(args.clone.depth)])}`);
  }

  const boxEnvFile: string[] = [
    `AGENTBOX_BOX_ID=${quoteShellArgv([args.boxId])}`,
    `AGENTBOX_BOX_NAME=${quoteShellArgv([args.boxName])}`,
    `AGENTBOX_BOX_KIND=cloud`,
  ];
  if (args.webProxyPort !== undefined)
    boxEnvFile.push(`AGENTBOX_WEB_PROXY_PORT=${quoteShellArgv([String(args.webProxyPort)])}`);
  if (args.boxHost) boxEnvFile.push(`AGENTBOX_BOX_HOST=${quoteShellArgv([args.boxHost])}`);

  // Control-plane topology: the daemon needs the upstream URL (process env)
  // regardless of push routing — it drives the registry/events/permissions, not
  // just leasing.
  if (args.controlPlaneUrl) {
    env.push(`AGENTBOX_CONTROL_PLANE_URL=${quoteShellArgv([args.controlPlaneUrl])}`);
  }

  // Git push routing (git.pushMode). The login-shell `git push` leases + pushes
  // direct only when this flag is set; otherwise it routes through the host relay.
  // `auto` (default) leases iff a control plane is configured for the box.
  const pushMode = args.gitPushMode ?? 'auto';
  const lease = pushMode === 'lease' || (pushMode === 'auto' && Boolean(args.controlPlaneUrl));
  if (lease) {
    boxEnvFile.push(`AGENTBOX_GIT_LEASE=1`);
  }

  return { env, boxEnvFile };
}

export async function kickCloudBootstrap(args: KickCloudBootstrapArgs): Promise<void> {
  const { env, boxEnvFile } = buildBootstrapEnv(args);

  const script = [
    `set -e`,
    // /etc/agentbox is root-owned; the non-root sandbox user needs sudo to
    // write the login-shell env file (cloud bases grant vscode passwordless
    // sudo; root SSH boxes fall through with SUDO=''). Quoted heredoc → the
    // values (already shell-quoted for `set -a; . box.env`) land verbatim.
    `if command -v sudo >/dev/null 2>&1; then SUDO='sudo -n'; else SUDO=''; fi`,
    `$SUDO mkdir -p /etc/agentbox`,
    `$SUDO tee /etc/agentbox/box.env >/dev/null <<'AGENTBOX_BOX_ENV_EOF'`,
    ...boxEnvFile,
    `AGENTBOX_BOX_ENV_EOF`,
    `export ${env.join(' ')}`,
    `/usr/local/bin/agentbox-ctl bootstrap`,
  ].join('\n');

  const r = await args.backend.exec(args.handle, bashScript(script));
  if (r.stdout && args.onLog) {
    for (const line of r.stdout.split('\n')) if (line.trim()) args.onLog(line);
  }
  if (r.exitCode !== 0) {
    throw new Error(`agentbox-ctl bootstrap failed: ${r.stderr || r.stdout}`);
  }
}
