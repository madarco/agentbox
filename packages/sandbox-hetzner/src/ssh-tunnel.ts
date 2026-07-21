/**
 * `SshTunnelManager` now lives in `@agentbox/sandbox-core` — hetzner,
 * digitalocean and remote-docker all reuse one ControlMaster implementation.
 * Kept as a re-export so this package's call sites keep their local import path.
 *
 * Hetzner's per-box ssh dir is un-namespaced (`~/.agentbox/boxes/<id>/ssh/`) —
 * it predates the namespace argument, and moving it would orphan the keys of
 * every already-running box.
 */
export {
  SshTunnelManager,
  controlSockPath,
  defaultBoxSshDir,
  type PortForward,
  type SshTunnelOpenOptions,
} from '@agentbox/sandbox-core';
