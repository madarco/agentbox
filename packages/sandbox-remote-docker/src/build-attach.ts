/**
 * `buildRemoteDockerAttach` — this provider's override of `Provider.buildAttach`.
 *
 * The cloud scaffold's default appends the inner command to the backend's
 * `attachArgv`, which for an SSH backend lands it on the *host* it connects to.
 * For hetzner that host IS the box. Here it is the machine running the engine —
 * the box is a container on it — so the inner command has to be wrapped in a
 * `docker exec` before it crosses the wire. Hence a full override (the same
 * pattern vercel and e2b use for their non-SSH attaches).
 *
 * The result is a plain `ssh … -t 'docker exec -it … bash -lc <tmux>'`, so the
 * CLI's PTY wrapper drives it exactly like any other provider's attach.
 */

import type { AttachKind, AttachSpec, BoxRecord, BuildAttachOptions } from '@agentbox/core';
import {
  hostTermForCloud,
  quoteShellArg,
  quoteShellArgv,
  renderInnerCommand,
} from '@agentbox/sandbox-cloud';
import { sshDestination, sshOptArgs } from '@agentbox/sandbox-core';
import { ensureTunnel, loginShell } from './remote-docker.js';
import { parseSandboxId } from './target.js';

const CONTAINER_USER = 'vscode';

export async function buildRemoteDockerAttach(
  box: BoxRecord,
  kind: AttachKind,
  opts: BuildAttachOptions = {},
): Promise<AttachSpec> {
  const sandboxId = box.cloud?.sandboxId;
  if (!sandboxId) {
    throw new Error(`remote-docker box ${box.name} has no sandboxId — record is malformed`);
  }
  const { target: remote, container } = parseSandboxId(sandboxId);
  const target = await ensureTunnel(sandboxId, remote);

  // The tmux session bring-up + attach, identical to every other cloud box.
  const inner = renderInnerCommand(kind, opts);
  const dockerArgv = [
    'exec',
    // `detached` only creates the session, so it needs no TTY — and asking for
    // one would make docker fail when the CLI runs it without a terminal.
    ...(opts.detached ? ['-i'] : ['-it']),
    '-u',
    opts.user ?? CONTAINER_USER,
    '-e',
    `TERM=${hostTermForCloud()}`,
    container,
    'bash',
    '-lc',
    inner,
  ];
  // Wrap in a LOGIN shell for the same reason every other remote invocation does
  // (see `loginShell` in ./remote-docker.ts): ssh runs this string in the remote
  // user's NON-login shell, where `docker` is often not on PATH (Docker Desktop
  // in /usr/local/bin, OrbStack in ~/.orbstack/bin). `bash -lc` sources the
  // profile so `docker` resolves. The `-t` PTY flows through bash into `docker
  // exec -it` unchanged.
  const remoteCommand = loginShell(`docker ${quoteShellArgv(dockerArgv)}`);

  const argv = [
    'ssh',
    ...sshOptArgs(target),
    // -t forces TTY allocation through ssh; without it tmux and readline break.
    ...(opts.detached ? [] : ['-t']),
    sshDestination(target),
    // One argv element: ssh hands the string to the remote login shell, which
    // re-parses it — so the docker argv is quoted, not concatenated.
    remoteCommand,
  ];
  return { argv };
}

/** Exposed for the unit test — the quoting is the part worth pinning down. */
export const _internal = { quoteShellArg };
