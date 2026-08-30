/**
 * `buildAgentCommand(spec)` — one commander tree per agent.
 *
 * `agentbox claude`, `agentbox codex` and `agentbox opencode` are the same
 * command: create a box, launch the agent in a detachable tmux session, plus
 * `attach` / `start` / `login`. They were three hand-maintained files totalling
 * 4,866 lines; this is the one implementation, and
 * `test/_fixtures/agent-cli-surface.json` is what proves collapsing them changed
 * nothing a user can type.
 */
import type { AttachOpenIn } from '@agentbox/config';
import { formatDetachNotice, type BoxRecord } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { attachRelayOptions } from '../../control-plane/box-plane.js';
import { runWrappedAttach } from '../../wrapped-pty/index.js';
import { runAgentCreate } from './create-action.js';
import { wireLoginAction } from './login.js';
import { wireAttachAction, wireStartAction } from './start-attach.js';
import {
  addCreateOptions,
  buildAttachSubcommand,
  buildLoginSubcommand,
  buildStartSubcommand,
  type AgentCreateOptions,
} from './options.js';
import type { AgentCliSpec, AgentSubcommands, AttachWrapped } from './types.js';

/** What an agent declares; the factory fills in `attachWrapped`. */
export type AgentCliSpecInput = Omit<AgentCliSpec, 'attachWrapped'>;

/**
 * Attach to a box's agent tmux session through the wrapped-pty footer (the same
 * channel host-action prompts use), then exit with the inner pty's code.
 */
function buildAttachWrapped(a: AgentCliSpec): AttachWrapped {
  return async function attachWrapped(
    box: BoxRecord,
    sessionName: string | undefined,
    reattach: string,
    onError?: (msg: string) => void,
    openIn?: AttachOpenIn,
  ): Promise<never> {
    const extras = (await a.hooks?.attachExtras?.(box)) ?? {};
    const code = await runWrappedAttach({
      container: box.container,
      dockerArgv: a.runtime.buildAttachArgv(box.container, sessionName),
      ...(await attachRelayOptions(box)),
      boxId: box.id,
      boxName: box.name,
      projectIndex: box.projectIndex,
      mode: a.id,
      // Always true for an agent: the session is tmux-backed, so `d: detach` is
      // a real action. `runWrappedAttach` defaults it from `mode === 'claude'`,
      // which is why codex and opencode had to pass it explicitly and why a
      // fourth agent would silently have lost the detach chord.
      detachable: true,
      detachNotice: formatDetachNotice(reattach, a.id),
      onError,
      openIn,
      ...extras,
    });
    process.exit(code);
  };
}

export function buildAgentCommand(input: AgentCliSpecInput): {
  command: Command;
  attachWrapped: AttachWrapped;
} {
  // `attachWrapped` closes over the finished spec, so build the object first and
  // fill the function in — the create body ends by calling it.
  const a = input as AgentCliSpec;
  const attachWrapped = buildAttachWrapped(a);
  a.attachWrapped = attachWrapped;

  const command = new Command(a.id);
  addCreateOptions(command, a).action(async (agentArgs: string[], opts: AgentCreateOptions) =>
    runAgentCreate(a, agentArgs, opts),
  );

  const subcommands: AgentSubcommands = {
    attach: wireAttachAction(a, buildAttachSubcommand(a)),
    start: wireStartAction(a, buildStartSubcommand(a)),
    login: wireLoginAction(a, buildLoginSubcommand(a)),
  };
  a.hooks?.extendCommand?.(command, subcommands);
  command.addCommand(subcommands.attach);
  command.addCommand(subcommands.start);
  command.addCommand(subcommands.login);
  return { command, attachWrapped };
}
