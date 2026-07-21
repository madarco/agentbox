/**
 * `SshTunnelManager` now lives in `@agentbox/sandbox-core` — hetzner,
 * digitalocean and remote-docker all reuse one ControlMaster implementation.
 * Kept as a re-export so this package's call sites keep their local import path.
 *
 * DigitalOcean's per-box ssh state stays namespaced under `digitalocean/` so a
 * droplet id can't collide with a Hetzner server id sharing the same numeric
 * value; the namespace is bound here rather than at every call site.
 */
import {
  SshTunnelManager as CoreSshTunnelManager,
  defaultBoxSshDir as coreDefaultBoxSshDir,
} from '@agentbox/sandbox-core';

export { controlSockPath } from '@agentbox/sandbox-core';
export type { PortForward, SshTunnelOpenOptions } from '@agentbox/sandbox-core';

const DIGITALOCEAN_SSH_NAMESPACE = 'digitalocean';

/** Default per-box ssh dir: `~/.agentbox/digitalocean/boxes/<box-id>/ssh/`. */
export function defaultBoxSshDir(boxId: string): string {
  return coreDefaultBoxSshDir(boxId, DIGITALOCEAN_SSH_NAMESPACE);
}

export class SshTunnelManager extends CoreSshTunnelManager {
  constructor() {
    super(DIGITALOCEAN_SSH_NAMESPACE);
  }
}
