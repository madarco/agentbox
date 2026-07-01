import type { CloudBackend, CloudHandle } from '@agentbox/core';
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
  onLog?: (line: string) => void;
}

export async function kickCloudBootstrap(args: KickCloudBootstrapArgs): Promise<void> {
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

  const script = [`set -e`, `export ${env.join(' ')}`, `/usr/local/bin/agentbox-ctl bootstrap`].join(
    '\n',
  );

  const r = await args.backend.exec(args.handle, bashScript(script));
  if (r.stdout && args.onLog) {
    for (const line of r.stdout.split('\n')) if (line.trim()) args.onLog(line);
  }
  if (r.exitCode !== 0) {
    throw new Error(`agentbox-ctl bootstrap failed: ${r.stderr || r.stdout}`);
  }
}
