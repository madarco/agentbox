import { resolveAgentSpec } from '@agentbox/sandbox-core';
import type { AgentCliSpec } from '@agentbox/cli-kit';
import { exampleRuntime } from './runtime.js';

/**
 * `agentbox example` as a descriptor.
 *
 * Hidden on its spec row, so it never appears in pickers or `--help` — but the
 * command is real, and that is the point: it proves an agent can supply a
 * complete CLI surface from its own package with no edit anywhere else.
 */
export const exampleCliSpec: Omit<AgentCliSpec, 'attachWrapped'> = {
  id: 'example',
  spec: resolveAgentSpec('example'),
  productName: 'Example Agent',
  shortName: 'Example',
  runtime: exampleRuntime,
  acceptsSeedPrompt: false,
  // Inert: `offerDockerLogin`/`offerCloudLogin` are no-ops for an agent with
  // no credential, so the timing never matters.
  signInOfferTiming: 'before-create',
  text: {
    description: 'Create a sandboxed box and launch the demo agent (a login shell)',
    isolateVolumeLabel: '~/.agentbox-example',
    syncConfigLabel: '~/.agentbox-example',
    argsExample: '',
    resumeIdWord: 'id',
    continueHelp: 'not supported by the demo agent',
    resumeHelp: 'not supported by the demo agent',
    startContinueHelp: 'not supported by the demo agent',
    startResumeHelp: 'not supported by the demo agent',
    attachDescription: "Attach to the demo agent's tmux session in a box",
    startDescription: 'Start the demo agent in an already-existing box',
    loginDescription: 'The demo agent has no login',
    loginArgsHelp: 'unused',
    loginInteractiveHelp: 'unused',
    resumeWithPromptError: 'the demo agent supports neither prompts nor resume.',
    hubIncompatibleReason: 'the demo agent has no hub-incompatible path.',
    resumeIntoRunningError: (boxName) => `cannot resume into ${boxName}: unsupported.`,
  },
};
