/**
 * The remote-docker addressing model.
 *
 * A box lives on *some* remote engine, and the code that has to reach it is not
 * always the code that created it: the host relay resolves a backend from a
 * bare `CloudHandle` (`{ sandboxId }`) with no access to the box record or the
 * user's config. So the SSH destination is encoded INTO the sandbox id:
 *
 *     sandboxId = "<ssh-destination>/<container-name>"
 *     e.g.        "buildbox/agentbox-brave-otter"
 *                 "dev@10.0.0.9:2222/agentbox-brave-otter"
 *
 * That makes the handle self-describing and multi-host support fall out for
 * free — no host-side registry to keep in sync, and a box keeps working after
 * `box.remoteDockerHost` changes.
 *
 * An SSH destination is anything OpenSSH accepts: an `~/.ssh/config` alias
 * (`buildbox`), or `[user@]host[:port]`. We deliberately do NOT parse it into
 * our own notion of identity/port beyond the `:port` suffix — the user's
 * `~/.ssh/config` is the source of truth for keys, ports and usernames, and
 * re-deriving them here would only let us contradict it.
 */

import type { SshTargetArgs } from '@agentbox/sandbox-core';

/** A parsed SSH destination. `user` / `port` are absent unless spelled out. */
export interface RemoteTarget {
  /** Host, IP, or `~/.ssh/config` alias. */
  host: string;
  user?: string;
  port?: number;
  /** The destination as the user wrote it — the canonical id-carrying form. */
  spec: string;
}

/** Container names are `agentbox-<box-name>`, matching the docker provider. */
export function containerNameFor(boxName: string): string {
  return `agentbox-${boxName}`;
}

/**
 * Parse `[user@]host[:port]` (or a bare ssh alias). Throws on an empty or
 * malformed destination — a bad host is worth failing loudly on, since every
 * later error would be an opaque ssh failure.
 */
export function parseRemoteTarget(spec: string): RemoteTarget {
  const raw = spec.trim();
  if (raw.length === 0) {
    throw new Error('remote-docker: empty SSH destination');
  }
  if (raw.includes('/')) {
    throw new Error(
      `remote-docker: invalid SSH destination "${raw}" — "/" separates the destination from the container in a sandbox id`,
    );
  }
  const at = raw.lastIndexOf('@');
  const user = at >= 0 ? raw.slice(0, at) : undefined;
  const hostPort = at >= 0 ? raw.slice(at + 1) : raw;
  if (hostPort.length === 0 || (user !== undefined && user.length === 0)) {
    throw new Error(`remote-docker: invalid SSH destination "${raw}"`);
  }

  // A bracketed IPv6 literal is the only form that can carry a port:
  // `[fe80::1]:2222`. Bare `fe80::1` is all host — its final `:1` is an address
  // group, not a port, and reading it as one would silently connect to :1.
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(hostPort);
  if (bracketed?.[1]) {
    const host = bracketed[1];
    if (bracketed[2] === undefined) return { host, user, spec: raw };
    return { host, user, port: checkedPort(bracketed[2], raw), spec: raw };
  }
  if (hostPort.includes(':')) {
    const colon = hostPort.lastIndexOf(':');
    const head = hostPort.slice(0, colon);
    const tail = hostPort.slice(colon + 1);
    // More than one colon ⇒ an unbracketed IPv6 literal ⇒ no port.
    if (!head.includes(':') && /^\d+$/.test(tail)) {
      return { host: head, user, port: checkedPort(tail, raw), spec: raw };
    }
  }
  return { host: hostPort, user, spec: raw };
}

function checkedPort(digits: string, raw: string): number {
  const port = Number.parseInt(digits, 10);
  if (port <= 0 || port > 65535) {
    throw new Error(`remote-docker: invalid SSH port in "${raw}"`);
  }
  return port;
}

/** `<ssh-destination>/<container>` — the persisted sandbox id. */
export function makeSandboxId(targetSpec: string, container: string): string {
  // Validate the destination now so a malformed one can't be persisted.
  parseRemoteTarget(targetSpec);
  return `${targetSpec}/${container}`;
}

export interface ParsedSandboxId {
  target: RemoteTarget;
  container: string;
}

/** Split a sandbox id back into its SSH destination and container name. */
export function parseSandboxId(sandboxId: string): ParsedSandboxId {
  const slash = sandboxId.lastIndexOf('/');
  if (slash <= 0 || slash === sandboxId.length - 1) {
    throw new Error(
      `remote-docker: malformed sandbox id "${sandboxId}" — expected "<ssh-destination>/<container>"`,
    );
  }
  return {
    target: parseRemoteTarget(sandboxId.slice(0, slash)),
    container: sandboxId.slice(slash + 1),
  };
}

/**
 * The `SshTargetArgs` for a destination. No `identity` and no `knownHosts`:
 * both come from the user's `~/.ssh/config` / agent / `~/.ssh/known_hosts`,
 * which is the whole point of pointing at a machine you already reach.
 */
export function sshTargetFor(target: RemoteTarget, controlPath?: string): SshTargetArgs {
  return {
    host: target.host,
    ...(target.user !== undefined ? { user: target.user } : {}),
    ...(target.port !== undefined ? { port: target.port } : {}),
    ...(controlPath !== undefined ? { controlPath } : {}),
  };
}
