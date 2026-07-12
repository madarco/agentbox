/**
 * The single chokepoint through which every `docker` command reaches the remote
 * engine: one persistent SSH ControlMaster per box, `docker …` run inside a
 * remote LOGIN shell.
 *
 * Why not `DOCKER_HOST=ssh://user@host`? Two reasons, both fatal in practice:
 *
 *   1. Docker's ssh transport runs `docker system dial-stdio` on the remote,
 *      which needs `docker` on the NON-login-shell PATH. That is exactly where
 *      OrbStack (`~/.orbstack/bin`) and Colima break, so a Mac remote — a case
 *      we explicitly support — would fail with an opaque "command not found".
 *      A login shell (`bash -lc`) sources the profile and finds them.
 *   2. It opens a fresh SSH connection per `docker` invocation. Create issues
 *      dozens; the ControlMaster amortizes the handshake to ~nothing.
 *
 * The trade is that we compose docker's argv into a shell string ourselves, so
 * every argument must be quoted — `quoteShellArgv` from @agentbox/sandbox-cloud
 * does that, and nothing in this package may build a remote command by
 * concatenation.
 */

import { execa } from 'execa';
import type { Readable, Writable } from 'node:stream';
import { quoteShellArg, quoteShellArgv } from '@agentbox/sandbox-cloud';
import {
  SshTunnelManager,
  sshDestination,
  sshExec,
  sshOptArgs,
  type SshTargetArgs,
} from '@agentbox/sandbox-core';
import { parseRemoteTarget, sshTargetFor, type RemoteTarget } from './target.js';

/** One ControlMaster per box, namespaced so ids can't collide with a VPS provider's. */
export const tunnels = new SshTunnelManager('remote-docker');

export interface RemoteExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Open (or reuse) the ControlMaster for a box and return an ssh target bound to
 * it. Every exec/upload/download/forward for that box rides this one connection.
 */
export async function ensureTunnel(
  sandboxId: string,
  target: RemoteTarget,
): Promise<SshTargetArgs> {
  if (!tunnels.has(sandboxId)) {
    try {
      await tunnels.open({
        boxId: sandboxId,
        vpsHost: target.host,
        ...(target.user !== undefined ? { vpsUser: target.user } : {}),
        ...(target.port !== undefined ? { port: target.port } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `remote-docker: cannot SSH to "${target.spec}". Check that \`ssh ${target.spec} true\` works from this machine ` +
          `(the provider uses your own ~/.ssh/config, agent and known_hosts — it mints no keys).\n${msg}`,
      );
    }
  }
  const controlPath = tunnels.controlPath(sandboxId);
  return sshTargetFor(target, controlPath);
}

/** Re-open a dead master (host sleep/wake, network blip) and drop stale forwards. */
export async function refreshTunnel(sandboxId: string, target: RemoteTarget): Promise<void> {
  await tunnels.refresh({
    boxId: sandboxId,
    vpsHost: target.host,
    ...(target.user !== undefined ? { vpsUser: target.user } : {}),
    ...(target.port !== undefined ? { port: target.port } : {}),
  });
}

/**
 * Run `docker <argv…>` on the remote engine. `argv` is quoted, so callers pass
 * a plain array and never think about the shell.
 */
export async function dockerOnRemote(
  target: SshTargetArgs,
  argv: string[],
  opts: { timeoutMs?: number; onLine?: (line: string) => void } = {},
): Promise<RemoteExecResult> {
  return sshExec(target, loginShell(`docker ${quoteShellArgv(argv)}`), {
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}),
  });
}

/** Same, but throws with the remote's stderr on a non-zero exit. */
export async function dockerOnRemoteOrThrow(
  target: SshTargetArgs,
  argv: string[],
  opts: { timeoutMs?: number; onLine?: (line: string) => void } = {},
): Promise<string> {
  const res = await dockerOnRemote(target, argv, opts);
  if (res.exitCode !== 0) {
    throw new Error(
      `remote-docker: \`docker ${argv.join(' ')}\` failed (exit ${String(res.exitCode)}): ${
        res.stderr.trim() || res.stdout.trim() || '(no output)'
      }`,
    );
  }
  return res.stdout;
}

/**
 * Run a command INSIDE the box's container: `docker exec … bash -lc '<cmd>'`.
 * This is what `CloudBackend.exec` is built on, so it carries the same
 * semantics the cloud scaffold expects (login shell, so `/etc/profile.d`
 * exports are visible).
 */
export function dockerExecArgv(
  container: string,
  command: string,
  opts: { user?: string; cwd?: string; env?: Record<string, string>; interactive?: boolean } = {},
): string[] {
  const argv = ['exec'];
  if (opts.interactive) argv.push('-i');
  if (opts.user) argv.push('-u', opts.user);
  if (opts.cwd) argv.push('-w', opts.cwd);
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    argv.push('-e', `${k}=${v}`);
  }
  argv.push(container, 'bash', '-lc', command);
  return argv;
}

/**
 * The user every exec and every file transfer runs as. It must be ONE user:
 * a file written as root that `exec` (as vscode) later has to delete leaves the
 * box wedged — and on a nested engine, where the container init is forced to
 * uid 0, `docker exec` with no `-u` would default to root and do exactly that.
 * So both sides name the user explicitly rather than inheriting the container's.
 */
export const CONTAINER_USER = 'vscode';

/**
 * Stream a local file into a file inside the container, over the ControlMaster.
 *
 * Not `docker cp`: that would need the bytes staged on the remote host first
 * (an extra hop and a temp file to clean up). Piping into `cat` inside the
 * container is one hop, binary-safe, and leaves nothing behind. `execa` is
 * driven directly here because the transfer needs a stdin stream, which the
 * text-in/text-out `sshExec` deliberately doesn't model.
 */
export async function pipeFileIntoContainer(
  target: SshTargetArgs,
  container: string,
  input: Readable,
  remotePath: string,
): Promise<void> {
  const remote = loginShell(
    `docker ${quoteShellArgv(['exec', '-i', '-u', CONTAINER_USER, container, 'sh', '-c', `cat > ${quoteShellArg(remotePath)}`])}`,
  );
  const res = await execa('ssh', [...sshOptArgs(target), sshDestination(target), remote], {
    reject: false,
    input,
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `remote-docker: upload to ${container}:${remotePath} failed (exit ${String(res.exitCode)}): ${
        typeof res.stderr === 'string' ? res.stderr : ''
      }`,
    );
  }
}

/** Stream a file out of the container into a local writable stream. */
export async function pipeFileFromContainer(
  target: SshTargetArgs,
  container: string,
  remotePath: string,
  output: Writable,
): Promise<void> {
  const remote = loginShell(
    `docker ${quoteShellArgv(['exec', '-u', CONTAINER_USER, container, 'cat', remotePath])}`,
  );
  const child = execa('ssh', [...sshOptArgs(target), sshDestination(target), remote], {
    reject: false,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdout?.pipe(output);
  const res = await child;
  if (res.exitCode !== 0) {
    throw new Error(
      `remote-docker: download of ${container}:${remotePath} failed (exit ${String(res.exitCode)}): ${
        typeof res.stderr === 'string' ? res.stderr : ''
      }`,
    );
  }
}

/**
 * `bash -lc '<cmd>'` — a LOGIN shell, so the remote user's profile is sourced
 * and `docker` is found wherever their engine put it (Docker Desktop in
 * /usr/local/bin, OrbStack in ~/.orbstack/bin, Linux packages in /usr/bin).
 * This is the single reason a macOS remote works without a PATH config key.
 */
export function loginShell(command: string): string {
  return `bash -lc ${quoteShellArg(command)}`;
}

/**
 * Preflight a destination: SSH reachable, `docker` on the login-shell PATH, and
 * the daemon actually answering. Returns the engine's version + arch for the
 * doctor / `agentbox remote-docker check` output.
 */
export async function probeRemoteEngine(
  spec: string,
): Promise<{ ok: true; version: string; arch: string; os: string } | { ok: false; error: string }> {
  let target: SshTargetArgs;
  try {
    target = sshTargetFor(parseRemoteTarget(spec));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const reach = await sshExec({ ...target, options: { ConnectTimeout: '10' } }, 'true', {
    timeoutMs: 20_000,
  });
  if (reach.exitCode !== 0) {
    return {
      ok: false,
      error: `cannot SSH to ${spec}: ${reach.stderr.trim() || `exit ${String(reach.exitCode)}`}`,
    };
  }
  const res = await dockerOnRemote(
    target,
    ['version', '--format', '{{.Server.Version}}|{{.Server.Arch}}|{{.Server.Os}}'],
    {
      timeoutMs: 30_000,
    },
  );
  if (res.exitCode !== 0) {
    const err = res.stderr.trim() || res.stdout.trim();
    if (/command not found|not found/i.test(err)) {
      return {
        ok: false,
        error: `\`docker\` is not on ${spec}'s login-shell PATH (${err}). Install Docker there, or add it to the remote user's profile.`,
      };
    }
    return { ok: false, error: `docker on ${spec} is not answering: ${err}` };
  }
  const [version = '', arch = '', os = ''] = res.stdout.trim().split('|');
  return { ok: true, version, arch, os };
}
