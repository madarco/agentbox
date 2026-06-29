import type { CloudBackend, CloudHandle } from '@agentbox/core';
import { bashScript, quoteShellArgv } from './shell.js';

/**
 * Launch the in-box `agentbox-ctl daemon` inside a cloud sandbox. The image
 * (built from `Dockerfile.box`) already bakes `/usr/local/bin/agentbox-ctl`,
 * so this only `exec`s it detached with the per-box env wired in.
 *
 * The relay env is intentionally `undefined` in v0: the in-sandbox relay box-
 * mode + host poller (Phase 4) is not wired yet. With those env vars absent
 * the supervisor's `RelayClient` short-circuits to a no-op, the supervisor
 * still schedules `agentbox.yaml` tasks/services, and `agentbox-ctl git push`
 * surfaces a clear "no relay configured" error.
 */
export interface LaunchCloudCtlArgs {
  backend: CloudBackend;
  handle: CloudHandle;
  boxId: string;
  boxName: string;
  /** When set, exported as AGENTBOX_RELAY_URL inside the box. v0 leaves unset. */
  relayUrl?: string;
  /** When set, exported as AGENTBOX_RELAY_TOKEN inside the box. v0 leaves unset. */
  relayToken?: string;
  /** When set, exported as AGENTBOX_BRIDGE_TOKEN inside the box. v0 leaves unset. */
  bridgeToken?: string;
  /**
   * When set, exported as AGENTBOX_WEB_PROXY_PORT so the in-box ctl binds its
   * WebProxy on this port instead of the default 80. Vercel uses 8080 because it
   * can't expose privileged ports.
   */
  webProxyPort?: number;
  /**
   * The bare host (no scheme) this box is reachable at, exported as
   * AGENTBOX_BOX_HOST so the in-box placeholder engine (`agentbox-ctl render`,
   * the `{{AGENTBOX_BOX_HOST}}` env-init pattern) resolves the real host instead
   * of the derived `<box-name>.localhost`. Set to `<name>.localhost` for portless
   * backends and to the public preview host (e.g. `<sub>.vercel.run`) for
   * public-URL backends. When unset the in-box engine falls back to deriving
   * `<box-name>.localhost` from AGENTBOX_BOX_NAME.
   */
  boxHost?: string;
}

export async function launchCloudCtlDaemon(args: LaunchCloudCtlArgs): Promise<void> {
  const env: string[] = [
    `AGENTBOX_BOX_ID=${quoteShellArgv([args.boxId])}`,
    `AGENTBOX_BOX_NAME=${quoteShellArgv([args.boxName])}`,
    `AGENTBOX_BOX_KIND=cloud`,
  ];
  if (args.relayUrl) env.push(`AGENTBOX_RELAY_URL=${quoteShellArgv([args.relayUrl])}`);
  if (args.relayToken) env.push(`AGENTBOX_RELAY_TOKEN=${quoteShellArgv([args.relayToken])}`);
  if (args.bridgeToken) env.push(`AGENTBOX_BRIDGE_TOKEN=${quoteShellArgv([args.bridgeToken])}`);
  if (args.webProxyPort !== undefined)
    env.push(`AGENTBOX_WEB_PROXY_PORT=${quoteShellArgv([String(args.webProxyPort)])}`);
  if (args.boxHost) env.push(`AGENTBOX_BOX_HOST=${quoteShellArgv([args.boxHost])}`);

  // The identity + placeholder subset persisted to /etc/agentbox/box.env so
  // interactive login shells (`agentbox shell`) and manual `agentbox-ctl render`
  // resolve the same values the supervisor's children inherit. Deliberately
  // excludes the relay/bridge tokens — they belong only in the daemon's process
  // env, not a 0644 file sourced by every login shell.
  const boxEnvFile: string[] = [
    `AGENTBOX_BOX_ID=${quoteShellArgv([args.boxId])}`,
    `AGENTBOX_BOX_NAME=${quoteShellArgv([args.boxName])}`,
    `AGENTBOX_BOX_KIND=cloud`,
  ];
  if (args.webProxyPort !== undefined)
    boxEnvFile.push(`AGENTBOX_WEB_PROXY_PORT=${quoteShellArgv([String(args.webProxyPort)])}`);
  if (args.boxHost) boxEnvFile.push(`AGENTBOX_BOX_HOST=${quoteShellArgv([args.boxHost])}`);

  // Port the in-box daemon serves the box-relay `/healthz` on (it binds
  // AGENTBOX_BOX_RELAY_PORT, default 8788). We pass relayUrl as
  // `http://127.0.0.1:8788`, so derive the port from it; fall back to 8788.
  const boxRelayPort = (() => {
    if (args.relayUrl) {
      try {
        const p = new URL(args.relayUrl).port;
        if (p) return Number.parseInt(p, 10);
      } catch {
        // unparseable URL → default
      }
    }
    return 8788;
  })();

  // nohup + & detaches the daemon from the exec channel; logs go to the file
  // the daemon already uses for Docker boxes so debugging is uniform.
  // /run and /var/log are root-owned — the non-root sandbox user needs sudo
  // to create the per-box dirs (devcontainers/base grants vscode passwordless
  // sudo). The daemon itself can run as the current user. The box.env write uses
  // a quoted heredoc (no expansion; safe across stop/start re-launches) sourced
  // by the image's /etc/profile.d/agentbox.sh shim.
  const script = [
    `set -e`,
    // Idempotent: if a healthy ctl daemon is already serving the box relay,
    // leave it — it already has the right env (relayUrl/token are stable across
    // a host-only reconnect), and a fresh spawn would just fail to bind :PORT
    // and linger as an orphan. Only a real sandbox restart kills the daemon, in
    // which case the probe fails and we (re)launch. Without this, every
    // start/resume/recover leaked another idle daemon. node is guaranteed
    // present (it runs agentbox-ctl); curl may not be.
    `if node -e 'require("http").get("http://127.0.0.1:${String(boxRelayPort)}/healthz",r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))' 2>/dev/null; then`,
    `  echo "agentbox-ctl daemon already healthy on :${String(boxRelayPort)}; skipping launch"`,
    `  exit 0`,
    `fi`,
    `if command -v sudo >/dev/null 2>&1; then SUDO='sudo -n'; else SUDO=''; fi`,
    `$SUDO mkdir -p /run/agentbox /var/log/agentbox /etc/agentbox`,
    `$SUDO chown "$(id -un):$(id -gn)" /run/agentbox /var/log/agentbox`,
    `$SUDO tee /etc/agentbox/box.env >/dev/null <<'AGENTBOX_BOX_ENV_EOF'`,
    ...boxEnvFile,
    `AGENTBOX_BOX_ENV_EOF`,
    `export ${env.join(' ')}`,
    `nohup /usr/local/bin/agentbox-ctl daemon >> /var/log/agentbox/ctl-daemon.log 2>&1 &`,
    `disown`,
    `echo started`,
  ].join('\n');

  const r = await args.backend.exec(args.handle, bashScript(script));
  if (r.exitCode !== 0) {
    throw new Error(`agentbox-ctl daemon launch failed: ${r.stderr || r.stdout}`);
  }
}
