/**
 * Thin wrappers around the system `ssh` / `scp` binaries used during
 * `prepareHetzner()` (and Phase 4's SshTunnelManager).
 *
 * These helpers compose flags that suppress the usual interactive prompts
 * (`StrictHostKeyChecking=accept-new`, `UserKnownHostsFile=<per-box file>`)
 * and bind to the per-key/per-box paths.
 *
 * We shell out to the system OpenSSH rather than a JS SSH library because:
 *   - The provider matrix already depends on system `ssh` for `agentbox
 *     shell` against Docker boxes (`docker exec` doesn't go through ssh,
 *     but `agentbox open`'s sshfs flow does).
 *   - OpenSSH's ControlMaster + dynamic port forwarding is exactly the
 *     primitive Phase 4 needs, and is hard to replicate in pure JS.
 *   - No native-dep crutch and no surprise binary sizes.
 */

import { execa, type ResultPromise } from 'execa';

export interface SshTargetArgs {
  /** VPS IP (or DNS name) — passed to ssh as user@host. */
  host: string;
  /** Remote user. Hetzner stock images come up with `root`; baked snapshots use `vscode`. */
  user: string;
  /** Absolute path to the per-box/per-prepare private key. */
  identity: string;
  /** Absolute path to the per-box known_hosts file. */
  knownHosts: string;
  /** Optional ControlMaster socket (set during Phase 4 SshTunnelManager). */
  controlPath?: string;
  /** Extra `-o key=value` settings (e.g. ConnectTimeout for prepare polling). */
  options?: Record<string, string>;
}

/** Compose the `-o … -i … -o UserKnownHostsFile=…` flags for ssh/scp. */
export function sshOptArgs(target: SshTargetArgs): string[] {
  const out: string[] = [
    '-i', target.identity,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${target.knownHosts}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'LogLevel=ERROR',
  ];
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
  /** Pipe extra env into the remote shell. */
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
 * Run a one-shot command on the target VPS over ssh. Returns the exit code
 * + captured stdout/stderr; non-zero exits do NOT throw — callers decide
 * what to do with them.
 */
export async function sshExec(
  target: SshTargetArgs,
  remoteCmd: string,
  opts: SshExecOptions = {},
): Promise<SshExecResult> {
  const argv = [
    ...sshOptArgs(target),
    `${target.user}@${target.host}`,
    remoteCmd,
  ];
  const child = execa('ssh', argv, {
    reject: false,
    timeout: opts.timeoutMs,
    env: { ...process.env, ...opts.env },
    stdio: opts.onLine ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  }) as ResultPromise;

  if (opts.onLine) {
    const handle = (chunk: Buffer | string) => {
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

export interface SshExecWithAgentOptions extends SshExecOptions {
  /**
   * Add `-R <inboxPort>:127.0.0.1:<hostPort>` to forward a localhost port on
   * the box back to a localhost port on the host. Used by the relay's git
   * fast path for HTTPS origins: the in-box git credential helper hits
   * 127.0.0.1:<inboxPort>, which tunnels back to the host's short-lived
   * credential proxy. Connection dies → forwarded socket goes away.
   */
  reverseForward?: { inboxPort: number; hostPort: number };
}

/**
 * Run a one-shot command over a *fresh* SSH connection (no ControlMaster
 * reuse) with the host's SSH agent forwarded (`-A`). The fresh connection is
 * deliberate: ControlMaster-multiplexed sessions inherit the master's
 * `ForwardAgent` setting, and our master is opened with that off — opening a
 * one-off master per call keeps the forwarded-agent socket on the box bound
 * 1:1 to the lifetime of this command.
 *
 * Returns the exit code + captured stdout/stderr; non-zero exits do NOT
 * throw — callers decide whether to fall back (e.g. bundle path) on a
 * `Permission denied (publickey)` or `agent refused` failure.
 */
export async function sshExecWithAgent(
  target: SshTargetArgs,
  remoteCmd: string,
  opts: SshExecWithAgentOptions = {},
): Promise<SshExecResult> {
  // Strip controlPath — we want a fresh master so `-A` actually engages.
  const freshTarget: SshTargetArgs = { ...target, controlPath: undefined };
  const argv: string[] = [
    '-A',
    '-o', 'ForwardAgent=yes',
  ];
  if (opts.reverseForward) {
    const { inboxPort, hostPort } = opts.reverseForward;
    argv.push('-R', `${String(inboxPort)}:127.0.0.1:${String(hostPort)}`);
    // Without this, ssh blocks waiting for the remote bind even if it would
    // immediately fail (e.g. port in use), wedging the push.
    argv.push('-o', 'ExitOnForwardFailure=yes');
  }
  argv.push(
    ...sshOptArgs(freshTarget),
    `${freshTarget.user}@${freshTarget.host}`,
    remoteCmd,
  );

  const child = execa('ssh', argv, {
    reject: false,
    timeout: opts.timeoutMs,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (opts.onLine) {
    const handle = (chunk: Buffer | string) => {
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

/** Copy a local file to the target VPS via `scp`. Throws on non-zero exit. */
export async function scpUpload(
  target: SshTargetArgs,
  localPath: string,
  remotePath: string,
  opts: SshExecOptions = {},
): Promise<void> {
  const argv = [
    ...sshOptArgs(target),
    localPath,
    `${target.user}@${target.host}:${remotePath}`,
  ];
  const res = await execa('scp', argv, {
    reject: false,
    timeout: opts.timeoutMs,
  });
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
    `${target.user}@${target.host}:${remotePath}`,
    localPath,
  ];
  const res = await execa('scp', argv, {
    reject: false,
    timeout: opts.timeoutMs,
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `scp download failed (exit ${String(res.exitCode)}): ${remotePath} → ${localPath}\n${res.stderr ?? ''}`,
    );
  }
}

/**
 * Poll the target until ssh succeeds (or `deadlineMs` elapses). Used by the
 * prepare orchestrator after `createServer` to wait for cloud-init to bring
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
