/**
 * `agentbox opencode` as a DESCRIPTOR. The commander tree is built by
 * `buildAgentCommand` in the CLI — see `@agentbox/agent-codex/cli` for why the
 * factory stays there.
 */
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import type { AgentCliSpec } from '@agentbox/cli-kit';
import { opencodeRuntime } from './runtime.js';

const STUB_HELP = 'session teleport (not yet supported for opencode in v1; emits a friendly error)';

export const opencodeCliSpec: Omit<AgentCliSpec, 'attachWrapped'> = {
  id: 'opencode',
  spec: resolveAgentSpec('opencode'),
  productName: 'OpenCode',
  shortName: 'OpenCode',
  runtime: opencodeRuntime,
  // OpenCode's interactive launch takes no seed prompt at all, so a resync
  // conflict warning is always surfaced on stderr rather than injected.
  acceptsSeedPrompt: false,
  signInOfferTiming: 'before-create',
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
    // Both unreachable in practice — teleport refuses on `caps.teleport: 'stub'`
    // before either can be reached — but the shared body asks for them, and an
    // accurate message that never prints beats a wrong one that might.
    resumeWithPromptError: '-i / --initial-prompt cannot be combined with -c / --resume.',
    hubIncompatibleReason:
      '--via-hub is ignored for --resume runs (they teleport host state at create time); building this box locally.',
    // Unreachable in practice — teleport refuses before a box is touched — but
    // the shared body asks for it, and a wrong-agent message would be worse than
    // an accurate one that never prints.
    resumeIntoRunningError: (boxName) =>
      `cannot resume into ${boxName}: an OpenCode session is already running. Kill it first or use \`agentbox opencode attach\`.`,
  },
};
