/**
 * `agentbox opencode` — the descriptor.
 *
 * No `preflight` hook: OpenCode declares `caps.teleport: 'stub'`, and
 * `prepareTeleport` refuses on that capability with the reason the registry row
 * carries, so `-c` / `--resume` produce the same friendly error the hand-written
 * command produced without any per-agent code here.
 */
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { buildAgentCommand } from '../command/factory.js';
import { opencodeRuntime } from './runtime.js';

const spec = resolveAgentSpec('opencode');

const STUB_HELP = 'session teleport (not yet supported for opencode in v1; emits a friendly error)';

const { command, attachWrapped } = buildAgentCommand({
  id: 'opencode',
  spec,
  productName: 'OpenCode',
  shortName: 'OpenCode',
  runtime: opencodeRuntime,
  // OpenCode's interactive launch takes no seed prompt at all, so a resync
  // conflict warning is always surfaced on stderr rather than injected.
  acceptsSeedPrompt: false,
  text: {
    description: 'Create a sandboxed box and launch OpenCode in a detachable tmux session',
    isolateVolumeLabel: 'OpenCode',
    syncConfigLabel: 'OpenCode config',
    argsExample: '-m anthropic/claude-sonnet-4-5',
    resumeIdWord: 'id',
    continueHelp: STUB_HELP,
    resumeHelp: STUB_HELP,
    startContinueHelp: STUB_HELP,
    startResumeHelp: STUB_HELP,
    attachDescription:
      'Attach to an OpenCode tmux session in a box, starting one if none is running (auto-unpause/start; never re-syncs config — use `opencode start` for that)',
    startDescription:
      'Start an OpenCode tmux session in an already-existing box (auto-unpause/start). If a session is already running, just attach.',
    loginDescription:
      'Sign in to OpenCode for use in sandboxes. Runs `opencode auth login` in a throwaway container against the shared opencode-config volume (interactive provider picker; pass e.g. `-- --provider anthropic`). Usable before the first `agentbox opencode`.',
    loginArgsHelp:
      'extra args forwarded to `opencode auth login`; place after `--`, e.g. `agentbox opencode login -- --provider anthropic`',
    loginInteractiveHelp: "attach your terminal to OpenCode's own login TUI (legacy passthrough)",
    // Unreachable in practice — teleport refuses before a box is touched — but
    // the shared body asks for it, and a wrong-agent message would be worse than
    // an accurate one that never prints.
    resumeIntoRunningError: (boxName) =>
      `cannot resume into ${boxName}: an OpenCode session is already running. Kill it first or use \`agentbox opencode attach\`.`,
  },
});

export const opencodeCommand = command;
export const attachOpencodeWrapped = attachWrapped;
