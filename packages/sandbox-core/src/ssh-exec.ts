/**
 * Thin wrappers around the system `ssh` / `scp` binaries — the shared transport
 * for every provider whose box is reached over SSH (hetzner, digitalocean,
 * remote-docker).
 *
 * We shell out to the system OpenSSH rather than a JS SSH library because
 * OpenSSH's ControlMaster + dynamic port forwarding (see `./ssh-tunnel.ts`) is
 * exactly the primitive these providers need and is hard to replicate in pure
 * JS — with no native-dep crutch.
 *
 * Two shapes of target share this module:
 *
 *   - **VPS providers** (hetzner, digitalocean) mint a per-box key and pin the
 *     host key in a per-box `known_hosts`. They pass `identity` + `knownHosts`,
 *     and the target is fully self-describing.
 *   - **remote-docker** connects to a machine the user already reaches, so it
 *     passes NEITHER: the identity, port, and even the username come from the
 *     user's own `~/.ssh/config` (an alias like `buildbox` is a legal `host`).
 *     Emitting `-i` / `UserKnownHostsFile` there would override exactly the
 *     configuration we want to inherit, so both are omitted when unset.
 */

import { execa, type ResultPromise } from 'execa';

export interface SshTargetArgs {
  /** Host, IP, or an `~/.ssh/config` alias — passed to ssh as `[user@]host`. */
  host: string;
  /**
   * Remote user. Omit to let `~/.ssh/config` (or the ssh default) decide —
   * required for the remote-docker "alias" targets, where forcing a user would
   * override the alias's own `User`.
   */
  user?: string;
  /** Absolute path to the private key. Omit to use the agent / ssh_config identities. */
  identity?: string;
  /** Absolute path to a dedicated known_hosts file. Omit to use the user's own. */
  knownHosts?: string;
  /** Non-default SSH port. Emitted as `-o Port=` so ssh AND scp both honor it. */
  port?: number;
  /** ControlMaster socket to reuse (see `SshTunnelManager`). */
  controlPath?: string;
  /** Extra `-o key=value` settings (e.g. ConnectTimeout for prepare polling). */
  options?: Record<string, string>;
}

/** `user@host`, or bare `host` when the user comes from `~/.ssh/config`. */
export function sshDestination(target: SshTargetArgs): string {
  return target.user ? `${target.user}@${target.host}` : target.host;
}

/** Compose the `-o … -i … -o UserKnownHostsFile=…` flags for ssh/scp. */
export function sshOptArgs(target: SshTargetArgs): string[] {
  const out: string[] = [];
  if (target.identity) {
    out.push('-i', target.identity);
  }
  if (target.knownHosts) {
    // A dedicated known_hosts only makes sense when we also isolate the global
    // one; without `knownHosts` we deliberately fall through to the user's.
    out.push(
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${target.knownHosts}`,
      '-o', 'GlobalKnownHostsFile=/dev/null',
    );
  }
  out.push(
    '-o', 'BatchMode=yes',
    '-o', 'LogLevel=ERROR',
    // Detect a dead/stalled peer and drop the connection instead of hanging
    // forever. If the host's IP flaps mid-command (roaming Wi-Fi, VPN toggle)
    // the return traffic is silently dropped and the ssh channel would
    // otherwise block with no EOF — seen as an `exec` that never returns.
    // 15s * 4 = a ~60s fail-fast so callers (retry wrappers, cleanup) can react.
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
  );
  // `-o Port=` rather than `-p`, because scp spells the same flag `-P`.
  if (target.port !== undefined) {
    out.push('-o', `Port=${String(target.port)}`);
  }
  if (target.controlPath) {
    out.push('-o', `ControlPath=${target.controlPath}`);
  }
  for (const [k, v] of Object.entries(target.options ?? {})) {
    out.push('-o', `${k}=${v}`);
  }
  return out;
}

export interface SshExecOptions {
  /** Stream stdout/stderr line-by-line into this callback. */
  onLine?: (line: string) => void;
  /** Pipe extra env into the LOCAL ssh process (not the remote shell). */
  env?: Record<string, string>;
  /** Per-command wall-clock cap (ms). */
  timeoutMs?: number;
}

export interface SshExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a one-shot command on the target over ssh. Returns the exit code +
 * captured stdout/stderr; non-zero exits do NOT throw — callers decide what to
 * do with them.
 *
 * Text in / text out. A caller that needs to stream binary through the same
 * connection (remote-docker's `docker exec -i … cat`) drives `execa` itself
 * with `sshOptArgs(target)` — layering `input`/`encoding` onto this signature
 * costs more in overload gymnastics than the two call sites are worth.
 */
export async function sshExec(
  target: SshTargetArgs,
  remoteCmd: string,
  opts: SshExecOptions = {},
): Promise<SshExecResult> {
  const argv = [...sshOptArgs(target), sshDestination(target), remoteCmd];
  const child = execa('ssh', argv, {
    reject: false,
    timeout: opts.timeoutMs,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ResultPromise;

  if (opts.onLine) {
    const handle = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) opts.onLine?.(line);
      }
    };
    child.stdout?.on('data', handle);
    child.stderr?.on('data', handle);
  }

  const res = await child;
  return {
    exitCode: typeof res.exitCode === 'number' ? res.exitCode : 1,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
  };
}

/** Copy a local file to the target via `scp`. Throws on non-zero exit. */
export async function scpUpload(
  target: SshTargetArgs,
  localPath: string,
  remotePath: string,
  opts: SshExecOptions = {},
): Promise<void> {
  const argv = [
    ...sshOptArgs(target),
    localPath,
    `${sshDestination(target)}:${remotePath}`,
  ];
  const res = await execa('scp', argv, { reject: false, timeout: opts.timeoutMs });
  if (res.exitCode !== 0) {
    throw new Error(
      `scp upload failed (exit ${String(res.exitCode)}): ${localPath} → ${remotePath}\n${res.stderr ?? ''}`,
    );
  }
}

/** Copy a remote file to the host via `scp`. Throws on non-zero exit. */
export async function scpDownload(
  target: SshTargetArgs,
  remotePath: string,
  localPath: string,
  opts: SshExecOptions = {},
): Promise<void> {
  const argv = [
    ...sshOptArgs(target),
    `${sshDestination(target)}:${remotePath}`,
    localPath,
  ];
  const res = await execa('scp', argv, { reject: false, timeout: opts.timeoutMs });
  if (res.exitCode !== 0) {
    throw new Error(
      `scp download failed (exit ${String(res.exitCode)}): ${remotePath} → ${localPath}\n${res.stderr ?? ''}`,
    );
  }
}

/**
 * Poll the target until ssh succeeds (or `deadlineMs` elapses). Used by the VPS
 * prepare orchestrators after `createServer` to wait for cloud-init to bring
 * sshd up. Returns true on success, false on timeout — callers throw with
 * appropriate context.
 */
export async function waitForSsh(
  target: SshTargetArgs,
  deadlineMs: number,
  intervalMs = 5_000,
): Promise<boolean> {
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) {
    const res = await sshExec(
      { ...target, options: { ...target.options, ConnectTimeout: '5' } },
      'true',
      { timeoutMs: 10_000 },
    );
    if (res.exitCode === 0) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
