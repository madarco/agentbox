/**
 * Opening a service agent's REPL — the interactive client of a daemon the box
 * hosts (`AgentServiceSpec.repl`).
 *
 * This is NOT an attach in the TUI sense and deliberately lives outside the
 * per-agent `attachWrapped` table: there is no agent session to attach to, the
 * daemon runs under ctl either way, and the command is pure registry data — so
 * one implementation serves every service agent that declares one. Adding a
 * second such agent is adding a `repl:` line.
 *
 * `agentbox attach` documents "does not auto-start". A REPL has no session
 * until someone asks for one, and asking for one IS the request, so this
 * start-or-attaches. That is the one place the two differ, and the reason it is
 * safe here: starting a client of a running daemon costs nothing, unlike
 * spawning an agent that would start burning tokens unattended.
 */
import { execa } from 'execa';
import type { AgentSyncSpec, BoxRecord } from '@agentbox/core';
import { isServiceAgent } from '@agentbox/core';
import {
  CONTAINER_USER,
  buildShellSessionAttachArgv,
  shellSessionInfo,
  buildTmuxSessionArgs,
} from '@agentbox/sandbox-docker';
import { attachRelayOptions } from '../control-plane/box-plane.js';
import { providerForBox } from '../provider/registry.js';
import { log } from '@agentbox/cli-kit';
import { runWrappedAttach } from '../wrapped-pty/run.js';
import { cloudAgentAttach } from '../commands/_cloud-attach.js';
import type { AttachOpenIn } from '@agentbox/config';

/** The agent's REPL argv, or undefined when it declares none. */
export function serviceReplArgv(spec: AgentSyncSpec | undefined): readonly string[] | undefined {
  if (!spec || !isServiceAgent(spec)) return undefined;
  const argv = spec.service?.repl;
  return argv && argv.length > 0 ? argv : undefined;
}

/**
 * Start the REPL's tmux session if it is not already up.
 *
 * Docker only — the cloud path's `provider.buildAttach` creates the session
 * itself (`tmux new-session -A`), which is why `openServiceRepl` doesn't call
 * this there.
 */
async function ensureDockerReplSession(
  container: string,
  sessionName: string,
  argv: readonly string[],
): Promise<void> {
  const info = await shellSessionInfo(container, sessionName, CONTAINER_USER);
  if (info.running) return;
  // tmux takes ONE shell-command string, so the argv is quoted back into one
  // rather than passed as separate words — the same shape `startClaudeSession`
  // uses. `-c /workspace` so the client starts where the user's files are.
  const cmd = argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ');
  const r = await execa(
    'docker',
    [
      'exec',
      '--user',
      CONTAINER_USER,
      container,
      'tmux',
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-c',
      '/workspace',
      cmd,
      ...buildTmuxSessionArgs(sessionName),
    ],
    { reject: false },
  );
  // A duplicate session is a race with another attach, not a failure.
  if (r.exitCode !== 0 && !/duplicate session/i.test(`${r.stderr}${r.stdout}`)) {
    throw new Error(
      `could not start the ${argv[0] ?? 'repl'} session in the box: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
}

/**
 * Start-or-attach a service agent's REPL. Never returns on the docker path
 * (the wrapper exits the process); the cloud path returns when the user detaches.
 */
export async function openServiceRepl(args: {
  box: BoxRecord;
  spec: AgentSyncSpec;
  argv: readonly string[];
  reattach: string;
  openIn?: AttachOpenIn;
}): Promise<void> {
  const { spec, argv } = args;
  const sessionName = spec.sessionName;

  // Bring the box up first. The cloud branch below does this itself inside
  // `cloudAgentAttach`, but the docker one goes straight to `docker exec`,
  // which just fails on a paused or stopped box — and the bare `<agent>`
  // command already resumes, so refusing here would be the odd one out. Safe
  // for the same reason start-on-attach is: the daemon is what the box is FOR.
  let box = args.box;
  const provider = await providerForBox(box);
  const state = await provider.probeState(box);
  if (state === 'missing') {
    throw new Error(`box ${box.name} has no sandbox left; destroy it and run this again`);
  }
  if (state === 'paused') {
    log.info(`resuming ${box.name}`);
    await provider.resume(box);
  } else if (state === 'stopped') {
    log.info(`starting ${box.name}`);
    box = await provider.start(box);
  }

  if ((box.provider ?? 'docker') !== 'docker') {
    // `buildAttach` takes the binary + its args and runs them under
    // `tmux new-session -A`, so start-or-attach is already the behaviour.
    await cloudAgentAttach({
      box,
      binary: argv[0]!,
      sessionName,
      mode: spec.id,
      extraArgs: [...argv.slice(1)],
      ...(args.openIn ? { openIn: args.openIn } : {}),
    });
    return;
  }

  await ensureDockerReplSession(box.container, sessionName, argv);
  const code = await runWrappedAttach({
    container: box.container,
    dockerArgv: buildShellSessionAttachArgv(box.container, sessionName, CONTAINER_USER),
    ...(await attachRelayOptions(box)),
    boxId: box.id,
    boxName: box.name,
    projectIndex: box.projectIndex,
    mode: spec.id,
    detachable: true,
    detachNotice: `Session detached. The ${spec.id} gateway keeps running. Reattach with: agentbox ${spec.id} attach ${args.reattach}`,
    ...(args.openIn ? { openIn: args.openIn } : {}),
  });
  process.exit(code);
}
