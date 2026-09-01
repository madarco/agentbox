/**
 * `agentbox pi` as a DESCRIPTOR. The commander tree is built by
 * `buildAgentCommand` in the CLI — see `@agentbox/agent-codex/cli` for why the
 * factory stays there.
 */
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import type { AgentCliSpec } from '@agentbox/cli-kit';
import { piRuntime } from './runtime.js';

export const piCliSpec: Omit<AgentCliSpec, 'attachWrapped'> = {
  id: 'pi',
  spec: resolveAgentSpec('pi'),
  productName: 'Pi',
  shortName: 'Pi',
  runtime: piRuntime,
  // `pi "<message>"` takes a leading positional as the opening turn.
  acceptsSeedPrompt: true,
  // `before-create`, like codex/opencode: on the cloud path that is AFTER the
  // hub-routing decision, so a box the control box will build never prompts for
  // a local sign-in it will not use. Pi has no setup wizard that could re-bake
  // a stale base, which is the only reason claude asks earlier.
  signInOfferTiming: 'before-create',
  text: {
    description: 'Create a sandboxed box and launch Pi in a detachable tmux session',
    isolateVolumeLabel: 'Pi',
    syncConfigLabel: 'Pi config',
    argsExample: '--model anthropic/claude-sonnet-4-5',
    resumeIdWord: 'id',
    continueHelp: "continue the host's most recent Pi session for this directory in the box",
    resumeHelp: 'teleport a specific host Pi session (uuid, or a unique prefix) into the box',
    startContinueHelp: "continue the host's most recent Pi session for this directory",
    startResumeHelp: 'teleport a specific host Pi session (uuid, or a unique prefix)',
    attachDescription:
      'Attach to a Pi tmux session in a box, starting one if none is running (auto-unpause/start; never re-syncs config — use `pi start` for that)',
    startDescription:
      'Start a Pi tmux session in an already-existing box (auto-unpause/start). If a session is already running, just attach.',
    loginDescription:
      "Sign in to Pi for use in sandboxes. Pi has no non-interactive login: this launches Pi's own TUI in a throwaway container against the shared pi-config volume, where you run `/login`, pick a provider, then `/exit`. The captured auth.json is reused by every later box.",
    loginArgsHelp: 'extra args forwarded to `pi`; place after `--`',
    loginInteractiveHelp: "attach your terminal to Pi's TUI (the only sign-in Pi has)",
    resumeWithPromptError: '-i / --initial-prompt cannot be combined with -c / --resume.',
    hubIncompatibleReason:
      '--via-hub is ignored for --resume runs (they teleport host state at create time); building this box locally.',
    resumeIntoRunningError: (boxName) =>
      `cannot resume into ${boxName}: a Pi session is already running. Kill it first or use \`agentbox pi attach\`.`,
  },
};
