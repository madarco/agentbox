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

  // nohup + & detaches the daemon from the exec channel; logs go to the file
  // the daemon already uses for Docker boxes so debugging is uniform.
  // /run and /var/log are root-owned — the non-root sandbox user needs sudo
  // to create the per-box dirs (devcontainers/base grants vscode passwordless
  // sudo). The daemon itself can run as the current user.
  const script = [
    `set -e`,
    `if command -v sudo >/dev/null 2>&1; then SUDO='sudo -n'; else SUDO=''; fi`,
    `$SUDO mkdir -p /run/agentbox /var/log/agentbox`,
    `$SUDO chown "$(id -un):$(id -gn)" /run/agentbox /var/log/agentbox`,
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
