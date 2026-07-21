/**
 * The `ssh` / `scp` wrappers now live in `@agentbox/sandbox-core` — hetzner,
 * digitalocean and remote-docker all drive the same OpenSSH transport. Kept as
 * a re-export so this package's call sites keep their local import path.
 */
export {
  scpDownload,
  scpUpload,
  sshExec,
  sshOptArgs,
  waitForSsh,
  type SshExecOptions,
  type SshExecResult,
  type SshTargetArgs,
} from '@agentbox/sandbox-core';
